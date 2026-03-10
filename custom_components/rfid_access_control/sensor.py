"""Sensor platform for RFID Access Control."""
import logging
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, CONF_DEVICE_ID, DATA_USERS_DB

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up RFID Access Control sensors."""
    data = hass.data[DOMAIN][entry.entry_id]
    device_id = data.get("coordinator", "rfid")
    db = data.get(DATA_USERS_DB)

    sensor = RFIDAccessControlUsersSensor(hass, entry, device_id, db)
    data["sensor"] = sensor
    async_add_entities([sensor])


class RFIDAccessControlUsersSensor(SensorEntity):
    """Sensor that exposes the list of registered users."""

    def __init__(self, hass, entry, device_id, db):
        """Initialize the sensor."""
        self._hass_obj = hass
        self._entry = entry
        self._device_id = device_id
        self._db = db
        self._attr_name = f"RFID Users {device_id}"
        self._attr_unique_id = f"rfid_access_control_{device_id}_users"
        self._attr_icon = "mdi:account-group"

    def _get_entry_data(self):
        """Get the integration data dict."""
        try:
            return self._hass_obj.data.get(DOMAIN, {}).get(self._entry.entry_id, {})
        except Exception:
            return {}

    @property
    def native_value(self):
        """Return number of users."""
        return len(self._db.users)

    @property
    def extra_state_attributes(self):
        """Return user list as attribute."""
        users_list = []
        for user in self._db.get_all_users():
            user_dict = user.to_dict()
            has_pin = bool(user_dict.get("pin"))
            has_rfid = bool(user_dict.get("rfid"))
            user_dict.pop("pin", None)
            user_dict["has_pin"] = has_pin
            user_dict["has_rfid"] = has_rfid
            actions = []
            for a in user.actions:
                actions.append({
                    "action_name": a.action_name,
                    "entity_id": a.entity_id,
                    "service": a.service,
                })
            user_dict["actions"] = actions
            users_list.append(user_dict)

        entry_data = self._get_entry_data()
        last_code = entry_data.get("last_code", "")
        last_code_time = entry_data.get("last_code_time", 0)

        return {
            "users": users_list,
            "device_id": self._device_id,
            "last_code": last_code,
            "last_code_time": last_code_time,
        }

    def update_state(self):
        """Force state update after user changes."""
        self.async_write_ha_state()
