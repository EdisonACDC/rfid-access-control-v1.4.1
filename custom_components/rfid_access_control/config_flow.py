"""Config flow for RFID Access Control."""
import logging
from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult

from .const import DOMAIN, CONF_DEVICE_ID, CONF_MQTT_TOPIC

_LOGGER = logging.getLogger(__name__)


class RFIDAccessControlConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for RFID Access Control."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Handle the initial step - ask for device ID and MQTT topic."""
        errors: dict[str, str] = {}

        if user_input is not None:
            device_id = user_input.get(CONF_DEVICE_ID, "").strip()
            mqtt_topic = user_input.get(CONF_MQTT_TOPIC, "").strip()

            if not device_id:
                errors["base"] = "no_device_id"
            elif not mqtt_topic:
                errors["base"] = "no_mqtt_topic"
            else:
                await self.async_set_unique_id(device_id)
                self._abort_if_unique_id_configured()

                return self.async_create_entry(
                    title=f"RFID Access Control - {device_id}",
                    data={
                        CONF_DEVICE_ID: device_id,
                        CONF_MQTT_TOPIC: mqtt_topic,
                    },
                )

        schema = vol.Schema({
            vol.Required(CONF_DEVICE_ID, default="tastierino_portoncino"): str,
            vol.Required(CONF_MQTT_TOPIC, default="zigbee2mqtt/tastierino_portoncino"): str,
        })

        return self.async_show_form(
            step_id="user",
            data_schema=schema,
            errors=errors,
        )

    async def async_step_import(self, import_data: dict[str, Any]) -> FlowResult:
        """Handle import from configuration.yaml."""
        return await self.async_step_user(import_data)
