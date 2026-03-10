"""RFID Access Control integration for Home Assistant - v1.3."""
import json
import logging
from pathlib import Path

from homeassistant.components import mqtt
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.helpers.typing import ConfigType
import voluptuous as vol

from .const import (
    DOMAIN,
    CONF_DEVICE_ID,
    CONF_MQTT_TOPIC,
    SERVICE_ADD_USER,
    SERVICE_REMOVE_USER,
    SERVICE_UPDATE_USER,
    SERVICE_ADD_ACTION,
    SERVICE_REMOVE_ACTION,
    SERVICE_VALIDATE_ACCESS,
    SERVICE_LIST_USERS,
    ATTR_USER_ID,
    ATTR_USER_NAME,
    ATTR_USER_PIN,
    ATTR_USER_RFID,
    ATTR_ACTION_ENTITY,
    ATTR_ACTION_SERVICE,
    ATTR_ACTION_DATA,
    EVENT_ACCESS_GRANTED,
    EVENT_ACCESS_DENIED,
    EVENT_USER_ADDED,
    EVENT_USER_REMOVED,
    DATA_COORDINATOR,
    DATA_USERS_DB,
    MIN_PIN_LENGTH,
    MAX_PIN_LENGTH,
    MIN_RFID_LENGTH,
)
from .models import AccessUser, AccessAction, AccessDatabase

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor"]

CONFIG_SCHEMA = vol.Schema({
    DOMAIN: vol.Schema({})
}, extra=vol.ALLOW_EXTRA)


def _update_sensor(hass, entry):
    """Update the sensor entity after data changes."""
    try:
        data = hass.data.get(DOMAIN, {}).get(entry.entry_id, {})
        sensor = data.get("sensor")
        if sensor:
            sensor.update_state()
    except Exception as e:
        _LOGGER.debug(f"Sensor update skipped: {e}")


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up RFID Access Control component."""
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up RFID Access Control from a config entry."""
    try:
        device_id = entry.data.get(CONF_DEVICE_ID)
        mqtt_topic = entry.data.get(CONF_MQTT_TOPIC, "")
        _LOGGER.info(f"Setting up RFID Access Control v1.3 for device: {device_id}")

        db = AccessDatabase()

        store_path = Path(hass.config.config_dir) / DOMAIN / f"{device_id}.json"
        try:
            if await hass.async_add_executor_job(store_path.exists):
                content = await hass.async_add_executor_job(store_path.read_text)
                data = json.loads(content)
                db.from_dict(data)
                _LOGGER.info(f"Loaded {len(db.users)} users from storage")
        except Exception as e:
            _LOGGER.error(f"Failed to load persistent data: {e}")

        hass.data[DOMAIN][entry.entry_id] = {
            DATA_COORDINATOR: device_id,
            DATA_USERS_DB: db,
            "store_path": store_path,
        }

        async def _execute_user_actions(user):
            """Execute all actions for a validated user."""
            user.record_access()
            await _save_database(hass, store_path, db)
            _update_sensor(hass, entry)

            hass.bus.async_fire(EVENT_ACCESS_GRANTED, {
                ATTR_USER_ID: user.user_id,
                ATTR_USER_NAME: user.user_name,
            })

            for action in user.actions:
                try:
                    domain_svc = action.service.split(".")
                    if len(domain_svc) == 2:
                        service_data = dict(action.service_data)
                        if action.entity_id:
                            service_data["entity_id"] = action.entity_id
                        await hass.services.async_call(
                            domain_svc[0],
                            domain_svc[1],
                            service_data,
                        )
                        _LOGGER.info(f"Action executed for {user.user_name}: {action.action_name}")
                    else:
                        _LOGGER.error(f"Invalid service format: {action.service}")
                except Exception as e:
                    _LOGGER.error(f"Failed to execute action '{action.action_name}': {e}")

            _LOGGER.info(f"Access GRANTED: {user.user_name}")

        async def _do_validate_access(pin="", rfid=""):
            """Validate credentials and execute actions."""
            user = db.find_user_by_credentials(pin=pin, rfid=rfid)
            if user:
                await _execute_user_actions(user)
                return True
            else:
                hass.bus.async_fire(EVENT_ACCESS_DENIED, {
                    "pin": "***" if pin else "",
                    "rfid": rfid[-4:] if rfid else "",
                })
                _LOGGER.warning("Access DENIED - Invalid credentials")
                return False

        async def _mqtt_validate(action_code, action_type):
            """Try to find user by PIN or RFID without double-firing denied events."""
            _LOGGER.info(f"MQTT validate: code='{action_code}', action='{action_type}'")

            import time
            hass.data[DOMAIN][entry.entry_id]["last_code"] = action_code
            hass.data[DOMAIN][entry.entry_id]["last_code_time"] = time.time()
            _update_sensor(hass, entry)

            hass.bus.async_fire("rfid_code_received", {
                "code": action_code,
                "action": action_type,
                "device_id": device_id,
            })

            is_rfid = (
                action_code.startswith("+") or
                any(c in action_code.upper() for c in "ABCDEF")
            )

            if is_rfid:
                user = db.find_user_by_credentials(rfid=action_code)
                if not user:
                    user = db.find_user_by_credentials(pin=action_code)
            else:
                user = db.find_user_by_credentials(pin=action_code)
                if not user:
                    user = db.find_user_by_credentials(rfid=action_code)

            if user:
                await _execute_user_actions(user)
            else:
                hass.bus.async_fire(EVENT_ACCESS_DENIED, {
                    "code_type": "rfid" if is_rfid else "pin",
                    "code_hint": action_code[-4:] if is_rfid else "***",
                })
                _LOGGER.warning(f"Access DENIED - No user found for {'RFID' if is_rfid else 'PIN'} code")

        @callback
        def _mqtt_message_received(msg):
            """Handle MQTT message from keypad."""
            try:
                payload = json.loads(msg.payload)
                action_code = payload.get("action_code", "")

                if not action_code:
                    return

                action_code = str(action_code).strip()
                if not action_code:
                    return

                action_type = str(payload.get("action", "")).lower()
                _LOGGER.info(f"Keypad event: action={action_type}, code length={len(action_code)}")

                hass.async_create_task(_mqtt_validate(action_code, action_type))

            except json.JSONDecodeError:
                _LOGGER.debug(f"Non-JSON MQTT message on keypad topic: {msg.payload}")
            except Exception as e:
                _LOGGER.error(f"Error processing keypad MQTT message: {e}")

        if mqtt_topic:
            try:
                unsubscribe = await mqtt.async_subscribe(
                    hass, mqtt_topic, _mqtt_message_received, qos=0
                )
                hass.data[DOMAIN][entry.entry_id]["mqtt_unsubscribe"] = unsubscribe
                _LOGGER.info(f"Subscribed to MQTT topic: {mqtt_topic}")
            except Exception as e:
                _LOGGER.error(f"Failed to subscribe to MQTT topic '{mqtt_topic}': {e}")

        async def handle_add_user(call: ServiceCall) -> None:
            """Add a new user."""
            try:
                data = call.data
                pin = data.get(ATTR_USER_PIN, "")
                rfid = data.get(ATTR_USER_RFID, "")

                if pin and (len(pin) < MIN_PIN_LENGTH or len(pin) > MAX_PIN_LENGTH):
                    _LOGGER.error(f"PIN must be {MIN_PIN_LENGTH}-{MAX_PIN_LENGTH} digits")
                    return

                if rfid and len(rfid) < MIN_RFID_LENGTH:
                    _LOGGER.error(f"RFID must be at least {MIN_RFID_LENGTH} characters")
                    return

                user = AccessUser(
                    user_id=data.get(ATTR_USER_ID, ""),
                    user_name=data.get(ATTR_USER_NAME, ""),
                    pin=pin,
                    rfid=rfid,
                )

                if db.add_user(user):
                    await _save_database(hass, store_path, db)
                    _update_sensor(hass, entry)
                    hass.bus.async_fire(EVENT_USER_ADDED, {
                        ATTR_USER_ID: user.user_id,
                        ATTR_USER_NAME: user.user_name,
                    })
                    _LOGGER.info(f"User added: {user.user_name} (PIN: {'yes' if pin else 'no'}, RFID: {'yes' if rfid else 'no'})")
                else:
                    _LOGGER.error(f"User already exists: {user.user_id}")
            except Exception as e:
                _LOGGER.error(f"Error adding user: {e}")

        async def handle_remove_user(call: ServiceCall) -> None:
            """Remove a user."""
            try:
                user_id = call.data.get(ATTR_USER_ID)
                if db.remove_user(user_id):
                    await _save_database(hass, store_path, db)
                    _update_sensor(hass, entry)
                    hass.bus.async_fire(EVENT_USER_REMOVED, {ATTR_USER_ID: user_id})
                    _LOGGER.info(f"User removed: {user_id}")
                else:
                    _LOGGER.error(f"User not found: {user_id}")
            except Exception as e:
                _LOGGER.error(f"Error removing user: {e}")

        async def handle_update_user(call: ServiceCall) -> None:
            """Update user information."""
            try:
                user_id = call.data.get(ATTR_USER_ID)
                user_data = {
                    k: v for k, v in call.data.items()
                    if k in ["user_name", "pin", "rfid", "enabled"]
                }
                if db.update_user(user_id, user_data):
                    await _save_database(hass, store_path, db)
                    _update_sensor(hass, entry)
                    _LOGGER.info(f"User updated: {user_id}")
                else:
                    _LOGGER.error(f"User not found: {user_id}")
            except Exception as e:
                _LOGGER.error(f"Error updating user: {e}")

        async def handle_add_action(call: ServiceCall) -> None:
            """Add an action to a user."""
            try:
                user_id = call.data.get(ATTR_USER_ID)
                user = db.get_user(user_id)
                if not user:
                    _LOGGER.error(f"User not found: {user_id}")
                    return

                action = AccessAction(
                    entity_id=call.data.get(ATTR_ACTION_ENTITY, ""),
                    service=call.data.get(ATTR_ACTION_SERVICE, ""),
                    service_data=call.data.get(ATTR_ACTION_DATA, {}),
                    action_name=call.data.get("action_name", ""),
                )

                user.actions.append(action)
                await _save_database(hass, store_path, db)
                _update_sensor(hass, entry)
                _LOGGER.info(f"Action '{action.action_name}' added to user: {user_id}")
            except Exception as e:
                _LOGGER.error(f"Error adding action: {e}")

        async def handle_remove_action(call: ServiceCall) -> None:
            """Remove an action from a user."""
            try:
                user_id = call.data.get(ATTR_USER_ID)
                action_name = call.data.get("action_name", "")
                user = db.get_user(user_id)
                if not user:
                    _LOGGER.error(f"User not found: {user_id}")
                    return

                original_count = len(user.actions)
                user.actions = [a for a in user.actions if a.action_name != action_name]

                if len(user.actions) < original_count:
                    await _save_database(hass, store_path, db)
                    _update_sensor(hass, entry)
                    _LOGGER.info(f"Action '{action_name}' removed from user: {user_id}")
                else:
                    _LOGGER.error(f"Action not found: {action_name}")
            except Exception as e:
                _LOGGER.error(f"Error removing action: {e}")

        async def handle_validate_access(call: ServiceCall) -> None:
            """Validate user access and execute actions (via service call)."""
            try:
                pin = call.data.get(ATTR_USER_PIN, "")
                rfid = call.data.get(ATTR_USER_RFID, "")
                await _do_validate_access(pin=pin, rfid=rfid)
            except Exception as e:
                _LOGGER.error(f"Error validating access: {e}")

        def handle_list_users(call: ServiceCall) -> None:
            """List all registered users."""
            try:
                users_data = [user.to_dict() for user in db.get_all_users()]
                for u in users_data:
                    u.pop("pin", None)
                hass.data[DOMAIN][entry.entry_id]["last_users"] = users_data
                _LOGGER.info(f"Listed {len(users_data)} users")
            except Exception as e:
                _LOGGER.error(f"Error listing users: {e}")

        for service_name, handler in [
            (SERVICE_ADD_USER, handle_add_user),
            (SERVICE_REMOVE_USER, handle_remove_user),
            (SERVICE_UPDATE_USER, handle_update_user),
            (SERVICE_ADD_ACTION, handle_add_action),
            (SERVICE_REMOVE_ACTION, handle_remove_action),
            (SERVICE_VALIDATE_ACCESS, handle_validate_access),
            (SERVICE_LIST_USERS, handle_list_users),
        ]:
            if not hass.services.has_service(DOMAIN, service_name):
                hass.services.async_register(DOMAIN, service_name, handler)

        try:
            await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
        except Exception as e:
            _LOGGER.error(f"Error forwarding platforms: {e}")

        _LOGGER.info(f"RFID Access Control v1.3 setup complete for '{device_id}' (MQTT: {mqtt_topic})")
        return True

    except Exception as e:
        _LOGGER.error(f"Failed to setup RFID Access Control: {e}")
        return False


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    try:
        data = hass.data[DOMAIN].get(entry.entry_id, {})
        mqtt_unsub = data.get("mqtt_unsubscribe")
        if mqtt_unsub:
            mqtt_unsub()
            _LOGGER.info("Unsubscribed from MQTT topic")

        if unload_ok := await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
            hass.data[DOMAIN].pop(entry.entry_id, None)
        return unload_ok
    except Exception as e:
        _LOGGER.error(f"Error unloading entry: {e}")
        return False


async def _save_database(hass: HomeAssistant, store_path: Path, db: AccessDatabase):
    """Save database to file."""
    try:
        store_path.parent.mkdir(parents=True, exist_ok=True)

        def save():
            store_path.write_text(json.dumps(db.to_dict(), indent=2))

        await hass.async_add_executor_job(save)
    except Exception as e:
        _LOGGER.error(f"Failed to save database: {e}")
