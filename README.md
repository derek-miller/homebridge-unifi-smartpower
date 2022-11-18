# homebridge-unifi-smartpower

[![NPM Version](https://img.shields.io/npm/v/homebridge-unifi-smartpower.svg)](https://www.npmjs.com/package/homebridge-unifi-smartpower)

# UniFi SmartPower Homebridge Platform Plugin

[UniFi SmartPower](https://store.ui.com/collections/unifi-network-smartpower) plugin
for [Homebridge](https://github.com/homebridge/homebridge).

## Models Supported

- [SmartPower PDU Pro (USP-PDU-Pro)](https://store.ui.com/collections/unifi-network-smartpower/products/usp-pdu-pro)
- [SmartPower Plug (USP-Plug)](https://store.ui.com/collections/unifi-accessories/products/unifi-smart-power)
- [SmartPower Strip (USP-Strip)](https://store.ui.com/collections/unifi-accessories/products/smartpower-strip)
- [Next-Generation Gateway Pro (UXG-Pro)](https://store.ui.com/products/unifi-next-generation-gateway-professional)

## Configuration

### Required Configuration

```json
{
  "platforms": [
    {
      "platform": "UniFiSmartPower",
      "name": "UniFi SmartPower",
      "host": "192.168.1.1", // Controller or CloudKey IP address
      "port": 443, // and port
      "username": "admin", // See note below about account credentials
      "password": "ubnt"
    }
  ]
}
```

#### Account Credentials

You can use your Ubiquiti account credentials, though 2FA is supported. However, it is strongly
recommend to create a local user with Admin privileges just for this plugin. See
[this Ubiquity Help Article](https://help.ui.com/hc/en-us/articles/1500011491541-UniFi-Manage-users-and-user-roles)
for creating new users.

### Optional Configuration

#### Include/Exclude Outlets

Outlets can be included or excluded by serial number and outlet number (see logs during startup):

```
{
  "platforms": [
    {
      // ... required config, see above
      "includeOutlets": ["<serial number>.<index>"], // Defaults to null
      "excludeOutlets": ["<serial number>.<index>"]  // Defaults to null
    }
  ]
}
```

### Advanced Configuration

These config values should not be configured under normal situations, but are
exposed nonetheless. Min, max, and default values are enforced to keep the
plugin usable.

#### Refresh Devices Poll Interval

The polling interval (in seconds) to query the API for devices changes:

```
{
  "platforms": [
    {
      // ... required config, see above
      "refreshDevicesPollInterval": <seconds>, // Defaults to 600
    }
  ]
}
```

#### Status Cache TTL

The time to live (in seconds) for a cached status to avoid excessive API calls:

```

{
  "platforms": [
    {
      // ... required config, see above
      "outletStatusCacheTtl": <seconds>, // Defaults to 15
    }
  ]
}

```

#### Status Poll Interval

The polling interval (in seconds) to query the API for status changes:

```

{
  "platforms": [
    {
      // ... required config, see above
      "outletStatusPollInterval": <seconds>, // Defaults to 15
    }
  ]
}

```
