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
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => this.discoverDevices());
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    let deviceStatuses: UniFiSmartPowerStatus[];
    try {
      deviceStatuses = await this.uniFiSmartPower.getDeviceStatuses();
    } catch (error: unknown) {
      this.log.error(
        'Failed to get status from UniFi; verify host, port, username, and password are correct',
      );
      return;
    }

    for (const deviceStatus of deviceStatuses) {
      const uuid = this.api.hap.uuid.generate(deviceStatus.device.serialNumber);
      const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);
      const accessory =
        existingAccessory ??
        new this.api.platformAccessory(this.config.name ?? 'UniFi SmartPower PDU', uuid);

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
        .setCharacteristic(this.Characteristic.Manufacturer, 'Ubiquiti')
        .setCharacteristic(this.Characteristic.Model, deviceStatus.device.model)
        .setCharacteristic(this.Characteristic.SerialNumber, deviceStatus.device.serialNumber)
        .setCharacteristic(this.Characteristic.FirmwareRevision, deviceStatus.device.version);

      for (const outlet of deviceStatus.outlets) {
        if (
          Array.isArray(this.config.excludeOutlets) &&
          this.config.excludeOutlets.includes(outlet.name)
        ) {
          continue;
        }
        if (
          Array.isArray(this.config.includeOutlets) &&
          !this.config.includeOutlets.includes(outlet.name)
        ) {
          continue;
        }
        new UniFiSmartPowerOutletPlatformAccessory(this, accessory, outlet);
      }

      // Remove any cached services that were orphaned.
      accessory.services
        .filter((service) => !discoveredServices.some((s) => Object.is(s, service)))
        .forEach((service) => {
          this.log.info('Removing orphaned service from cache:', service.displayName);
          accessory.removeService(service);
        });

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', accessory.displayName);
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info('Adding new accessory:', accessory.displayName);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      const orphanedAccessories = this.accessories.filter((accessory) => accessory.UUID !== uuid);
      if (orphanedAccessories.length > 0) {
        this.log.info(
          'Removing orphaned accessories from cache: ',
          orphanedAccessories.map(({ displayName }) => displayName).join(', '),
        );
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, orphanedAccessories);
      }
    }
  }
}
