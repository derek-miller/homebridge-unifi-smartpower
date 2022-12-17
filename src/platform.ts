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
  UniFiSmartPowerOutletPlatformAccessoryContext,
} from './platformAccessory';
import { UniFiSmartPower, UniFiSmartPowerConfig, UniFiSmartPowerStatus } from './uniFiSmartPower';

type UniFiSmartPowerHomebridgePlatformConfig = PlatformConfig &
  UniFiSmartPowerConfig & {
    includeOutlets?: string[];
    excludeOutlets?: string[];
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

    let deviceStatuses: UniFiSmartPowerStatus[];
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
      const uuid = this.api.hap.uuid.generate(deviceStatus.device.serialNumber);
      const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);
      const accessory =
        existingAccessory ??
        new this.api.platformAccessory(this.config.name ?? 'UniFi SmartPower', uuid);

      // Update the accessory context with the general info.
      accessory.context = <UniFiSmartPowerOutletPlatformAccessoryContext>{
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
      };
      patch('getService');
      patch('addService');
      patch('getServiceById');

      accessory
        .getService(this.Service.AccessoryInformation)!
        .setCharacteristic(this.Characteristic.Name, deviceStatus.device.name)
        .setCharacteristic(this.Characteristic.Manufacturer, 'Ubiquiti')
        .setCharacteristic(this.Characteristic.Model, deviceStatus.device.model)
        .setCharacteristic(this.Characteristic.SerialNumber, deviceStatus.device.serialNumber)
        .setCharacteristic(this.Characteristic.FirmwareRevision, deviceStatus.device.version);

      let hasAnyOutlets = false;
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
        hasAnyOutlets = true;
        new UniFiSmartPowerOutletPlatformAccessory(this, accessory, outlet);
      }

      // Remove any cached services that were orphaned.
      accessory.services
        .filter((service) => !discoveredServices.some((s) => Object.is(s, service)))
        .forEach((service) => {
          this.log.info('Removing orphaned service from cache:', service.displayName);
          accessory.removeService(service);
        });

      if (hasAnyOutlets && existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', accessory.displayName);
        this.api.updatePlatformAccessories([accessory]);
        uuids.add(uuid);
      } else if (hasAnyOutlets) {
        this.log.info('Adding new accessory:', accessory.displayName);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        uuids.add(uuid);
        this.accessories.push(accessory);
      }
      accessory.services
        .filter((s) => s instanceof this.Service.Outlet && s.subtype)
        .forEach((s) => this.log.info('Outlet [%s]: %s', s.subtype ?? '', s.displayName ?? ''));
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
