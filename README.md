# homebridge-unifi-smartpower

[![NPM Version](https://img.shields.io/npm/v/homebridge-unifi-smartpower.svg)](https://www.npmjs.com/package/homebridge-unifi-smartpower)

# UniFi SmartPower Homebridge Platform Plugin

[UniFi SmartPower](https://store.ui.com/collections/unifi-network-smartpower) plugin
for [Homebridge](https://github.com/homebridge/homebridge).

## Models Supported

- TBD

## Configuration

### Required Configuration

```json
{
  "platforms": [
    {
      "platform": "UniFiSmartPower",
      "name": "UniFi SmartPower",
      "host": "192.168.1.1",
      "port": 443,
      "username": "admin",
      "password": "ubnt"
    }
  ]
}
```

### Optional Configuration

#### Include/Exclude Outlets

Outlets can be included or excluded by name:

```
{
  "platforms": [
    {
      // ... required config, see above
      "includeOutlets": ["<name>"], // Defaults to null
      "excludeOutlets": ["<name>"] // Defaults to null
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

```
