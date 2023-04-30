import { Characteristic, CharacteristicValue, Logger, PlatformAccessory } from 'homebridge';

import { UniFiSmartPowerHomebridgePlatform } from './platform';

export interface UniFiControlSwitchPlatformAccessoryContext {
  switchName: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  timeout?: number;
}

export class UniFiControlSwitchPlatformAccessory {
  private readonly log: Logger;
  private readonly context: UniFiControlSwitchPlatformAccessoryContext;
  private readonly switchName: string;
  private readonly manufacturer: string;
  private readonly model: string;
  private readonly serialNumber: string;
  private readonly timeout: number;
  private readonly id: string;

  private enabled = false;
  private onCharacteristic: Characteristic;

  constructor(
    private readonly platform: UniFiSmartPowerHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.log = this.platform.log;
    this.context = <UniFiControlSwitchPlatformAccessoryContext>this.accessory.context;
    this.switchName = this.context.switchName;
    this.manufacturer = this.context.manufacturer;
    this.model = this.context.model;
    this.serialNumber = this.context.serialNumber;
    this.timeout = this.context.timeout ?? 0;
    this.id = this.serialNumber;
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, this.manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, this.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.serialNumber);

    this.onCharacteristic = (this.accessory.getService(this.platform.Service.Switch) ||
      this.accessory.addService(this.platform.Service.Switch, this.switchName, this.id))!
      .setCharacteristic(this.platform.Characteristic.Name, this.switchName)
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));
  }

  private setOn(value: CharacteristicValue): void {
    this.log.debug('[%s] Set Characteristic On ->', this.switchName, value);
    this.enabled = !!value;
    if (this.enabled && this.timeout > 0) {
      setTimeout(() => {
        // Ignore if it has already been re-disabled.
        if (!this.enabled) {
          return;
        }
        this.enabled = false;
        this.log.debug(
          '[%s] Update Characteristic On due to enabled timeout ->',
          this.switchName,
          this.enabled,
        );
        this.onCharacteristic.updateValue(this.enabled);
      }, this.timeout * 1000);
    }
  }

  private getOn(): CharacteristicValue {
    this.log.debug('[%s] Get Characteristic On ->', this.switchName, this.enabled);
    return this.isEnabled();
  }

  public isEnabled() {
    return this.enabled;
  }
}
