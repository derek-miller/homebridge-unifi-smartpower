import {
  API,
  APIEvent,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import {
  UniFiSmartPowerOutletPlatformAccessory,
  UniFiDevicePlatformAccessoryContext,
  UniFiSwitchPortPlatformAccessory,
} from './platformAccessory';
import { UniFiSmartPower, UniFiControllerConfig, UniFiDeviceStatus } from './uniFiSmartPower';

type UniFiSmartPowerHomebridgePlatformConfig = PlatformConfig &
  UniFiControllerConfig & {
    includeDevices?: string[];
    excludeDevices?: string[];
    includeOutlets?: string[];
    excludeOutlets?: string[];
    includeInactivePorts?: boolean;
    excludePorts?: string[];
    includePorts?: string[];
  };

export class UniFiSmartPowerHomebridgePlatform implements DynamicPlatformPlugin {
  private static readonly REFRESH_DEVICES_POLL_INTERVAL_S_DEFAULT = 10 * 60 * 1000; // 10m
  private static readonly REFRESH_DEVICES_POLL_INTERVAL_S_MIN = 2 * 60 * 1000; // 2m
  private static readonly REFRESH_DEVICES_POLL_INTERVAL_S_MAX = 60 * 60 * 1000; // 60m

  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  public readonly config: UniFiSmartPowerHomebridgePlatformConfig;
  public readonly uniFiSmartPower: UniFiSmartPower;

  constructor(
    public readonly log: Logger,
    public readonly platformConfig: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.config = <UniFiSmartPowerHomebridgePlatformConfig>this.platformConfig;
    this.uniFiSmartPower = new UniFiSmartPower(log, this.config);
    const refreshDevices = async () => {
      await this.discoverDevices();
      setTimeout(refreshDevices, this.refreshDevicesPollIntervalMs);
    };
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, refreshDevices);
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    this.uniFiSmartPower.reset();

    let deviceStatuses: UniFiDeviceStatus[];
    try {
      deviceStatuses = await this.uniFiSmartPower.getDeviceStatuses();
    } catch (error: unknown) {
      this.log.error(
        'Failed to get status from UniFi; verify host, port, username, and password are correct: ',
        (<Error>error).stack || error,
      );
      return;
    }

    const uuids: Set<string> = new Set();
    for (const deviceStatus of deviceStatuses) {
      if (
        Array.isArray(this.config.excludeDevices) &&
        this.config.excludeDevices.includes(deviceStatus.device.serialNumber)
      ) {
        continue;
      }
      if (
        Array.isArray(this.config.includeDevices) &&
        !this.config.includeDevices.includes(deviceStatus.device.serialNumber)
      ) {
        continue;
      }

      const uuid = this.api.hap.uuid.generate(deviceStatus.device.serialNumber);
      const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);
      const accessory =
        existingAccessory ?? new this.api.platformAccessory(deviceStatus.device.name, uuid);

      // Update the accessory context with the general info.
      accessory.context = <UniFiDevicePlatformAccessoryContext>{
        device: deviceStatus.device,
      };

      // Monkeypatch accessory methods for getting services in order to identify orphaned services.
      const discoveredServices: Array<Service> = [];
      const patch = (methodName) => {
        const original = accessory[methodName].bind(accessory);
        accessory[methodName] = (...args) => {
          const service = original(...args);
          if (service) {
            discoveredServices.push(service);
          }
          return service;
        };
        return () => {
          accessory[methodName] = original;
        };
      };
      const patches = [patch('getService'), patch('addService'), patch('getServiceById')];

      accessory
        .getService(this.Service.AccessoryInformation)!
        .setCharacteristic(this.Characteristic.Name, deviceStatus.device.name)
        .setCharacteristic(this.Characteristic.Manufacturer, 'Ubiquiti')
        .setCharacteristic(this.Characteristic.Model, deviceStatus.device.model)
        .setCharacteristic(this.Characteristic.SerialNumber, deviceStatus.device.serialNumber)
        .setCharacteristic(this.Characteristic.FirmwareRevision, deviceStatus.device.version);

      let hasAnyAccessories = false;
      const logMessages: string[] = [
        `Device [${deviceStatus.device.serialNumber}]: ${deviceStatus.device.name}`,
      ];
      for (const outlet of deviceStatus.outlets) {
        // Use the name of the device if there is only a single outlet.
        if (deviceStatus.outlets.length === 1) {
          outlet.name = deviceStatus.device.name;
        }
        const accessoryId = `${deviceStatus.device.serialNumber}.${outlet.index}`;
        if (
          Array.isArray(this.config.excludeOutlets) &&
          this.config.excludeOutlets.includes(accessoryId)
        ) {
          continue;
        }
        if (
          Array.isArray(this.config.includeOutlets) &&
          !this.config.includeOutlets.includes(accessoryId)
        ) {
          continue;
        }
        logMessages.push(
          `Outlet [${deviceStatus.device.serialNumber}.${outlet.index}]: ${deviceStatus.device.name} > ${outlet.name}`,
        );
        hasAnyAccessories = true;
        new UniFiSmartPowerOutletPlatformAccessory(this, accessory, outlet);
      }

      for (const port of deviceStatus.ports) {
        // // Use the name of the device if there is only a single outlet.
        if (!port.active && !this.config.includeInactivePorts) {
          continue;
        }
        if (deviceStatus.ports.length === 1) {
          port.name = `${deviceStatus.device.name} ${port.name}`;
        }
        const accessoryId = `${deviceStatus.device.serialNumber}.${port.index}`;
        if (
          Array.isArray(this.config.excludePorts) &&
          this.config.excludePorts.includes(accessoryId)
        ) {
          continue;
        }
        if (
          Array.isArray(this.config.includePorts) &&
          !this.config.includePorts.includes(accessoryId)
        ) {
          continue;
        }
        logMessages.push(
          `Port [${deviceStatus.device.serialNumber}.${port.index}]: ${deviceStatus.device.name} > ${port.name}`,
        );
        hasAnyAccessories = true;
        new UniFiSwitchPortPlatformAccessory(this, accessory, port);
      }

      patches.forEach((unpatch) => unpatch());

      // Remove any cached services that were orphaned.
      accessory.services
        .filter((service) => !discoveredServices.some((s) => Object.is(s, service)))
        .forEach((service) => {
          this.log.info('Removing orphaned service from cache:', service.displayName);
          accessory.removeService(service);
        });

      if (hasAnyAccessories && existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', accessory.displayName);
        logMessages.forEach((m) => this.log.info(m));
        this.api.updatePlatformAccessories([accessory]);
        uuids.add(uuid);
      } else if (hasAnyAccessories) {
        this.log.info('Adding new accessory:', accessory.displayName);
        logMessages.forEach((m) => this.log.info(m));
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        uuids.add(uuid);
        this.accessories.push(accessory);
      }
    }
    const orphanedAccessories = this.accessories.filter((accessory) => !uuids.has(accessory.UUID));
    if (orphanedAccessories.length > 0) {
      this.log.info(
        'Removing orphaned accessories from cache: ',
        orphanedAccessories.map(({ displayName }) => displayName).join(', '),
      );
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, orphanedAccessories);
      for (const orphanedAccessory of orphanedAccessories) {
        this.accessories.splice(
          this.accessories.findIndex((accessory) => accessory.UUID === orphanedAccessory.UUID),
          1,
        );
      }
    }
  }

  private get refreshDevicesPollIntervalMs(): number {
    return (
      Math.max(
        UniFiSmartPowerHomebridgePlatform.REFRESH_DEVICES_POLL_INTERVAL_S_MIN,
        Math.min(
          UniFiSmartPowerHomebridgePlatform.REFRESH_DEVICES_POLL_INTERVAL_S_MAX,
          this.config.refreshDevicesPollInterval ??
            UniFiSmartPowerHomebridgePlatform.REFRESH_DEVICES_POLL_INTERVAL_S_DEFAULT,
        ),
      ) * 1000
    );
  }
}
