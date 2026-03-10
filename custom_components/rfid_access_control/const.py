"""Constants for RFID Access Control."""

DOMAIN = "rfid_access_control"

# Device model identifiers (Zigbee)
SUPPORTED_MODELS = {
    "KEPZB-110": {
        "name": "KEPLERO Keypad",
        "manufacturer": "Frient A/S",
        "device_type": "ZHAPresence",
    }
}

# Configuration keys
CONF_DEVICE_ID = "device_id"
CONF_MQTT_TOPIC = "mqtt_topic"
CONF_USERS = "users"
CONF_KEYPAD_ATTRIBUTE = "keypad_attribute"

# User attributes
ATTR_USER_ID = "user_id"
ATTR_USER_NAME = "user_name"
ATTR_USER_PIN = "user_pin"
ATTR_USER_RFID = "user_rfid"
ATTR_USER_ACTIONS = "user_actions"
ATTR_ACTION_ENTITY = "action_entity"
ATTR_ACTION_SERVICE = "action_service"
ATTR_ACTION_DATA = "action_data"

# Services
SERVICE_ADD_USER = "add_user"
SERVICE_REMOVE_USER = "remove_user"
SERVICE_UPDATE_USER = "update_user"
SERVICE_ADD_ACTION = "add_action"
SERVICE_REMOVE_ACTION = "remove_action"
SERVICE_VALIDATE_ACCESS = "validate_access"
SERVICE_LIST_USERS = "list_users"

# Events
EVENT_ACCESS_GRANTED = "rfid_access_granted"
EVENT_ACCESS_DENIED = "rfid_access_denied"
EVENT_USER_ADDED = "rfid_user_added"
EVENT_USER_REMOVED = "rfid_user_removed"

# Data keys
DATA_COORDINATOR = "coordinator"
DATA_USERS_DB = "users_db"

# Validation
MIN_PIN_LENGTH = 4
MAX_PIN_LENGTH = 8
MIN_RFID_LENGTH = 8
MAX_USERS = 100

# Keypad events mapping
KEYPAD_EVENTS = {
    "rfid": "rfid_detected",
    "pin": "pin_entered",
    "access_granted": "access_granted",
    "access_denied": "access_denied",
}
