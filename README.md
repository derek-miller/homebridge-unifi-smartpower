# homebridge-unifi-smartpower

[![NPM Version](https://img.shields.io/npm/v/homebridge-unifi-smartpower.svg)](https://www.npmjs.com/package/homebridge-unifi-smartpower)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

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

#### Control Switch

Considering how easy it is to accidentally command an outlet/switch from HomeKit
you can optionally add a switch to enable/disable control. When disabled,
commands to control an outlet/switch will be ignored:

```
{
  "platforms": [
    {
      // ... required config, see above
      "controlSwitch": {
        "create": <true/false>, // Defaults to false.
        "name": "<name>" // Defaults to "UniFi Control Enabled".
        "timeout": <number> // Timeout (in seconds) before the control switch reverts. Defaults to 60s. 0 disables the timeout.
      }
    }
  ]
}
```

#### Include/Exclude

Sites, devices, outlets, and/or ports can be included or excluded by their id (see logs during startup):

```
{
  "platforms": [
    {
      // ... required config, see above
      "includeSites": ["<site id>"], // Defaults to null
      "excludeSites": ["<site id>"],  // Defaults to null
      "includeDevices": ["<serial number>"], // Defaults to null
      "excludeDevices": ["<serial number>"],  // Defaults to null
      "includeOutlets": ["<serial number>.<index>"], // Defaults to null
      "excludeOutlets": ["<serial number>.<index>"],  // Defaults to null
      "includeInactivePorts": <true/false>, // Defaults to false
      "includePorts": ["<serial number>.<index>"], // Defaults to null
      "excludePorts": ["<serial number>.<index>"]  // Defaults to null
    }
  ]
}
```

NOTE: When `includeInactivePorts` is set to `true` all PoE capable ports will be added regardless if
the switch is supplying power to a connected device or not. This is not recommended since the plugin
will refresh and automatically add new ports when they become connected. Leaving this set to `false`
will reduce clutter in the Home app by removing switches that do not control anything.

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
