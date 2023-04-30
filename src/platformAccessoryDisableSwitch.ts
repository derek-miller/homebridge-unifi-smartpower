import { Characteristic, CharacteristicValue, Logger, PlatformAccessory } from 'homebridge';

import { UniFiSmartPowerHomebridgePlatform } from './platform';

export interface UniFiDisableControlPlatformAccessoryContext {
  switchName: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  timeout?: number;
}

export class UniFiDisableControlPlatformAccessory {
  private readonly log: Logger;
  private readonly context: UniFiDisableControlPlatformAccessoryContext;
  private readonly switchName: string;
  private readonly manufacturer: string;
  private readonly model: string;
  private readonly serialNumber: string;
  private readonly timeout: number;
  private readonly id: string;

  private disabled = true;
  private onCharacteristic: Characteristic;

  constructor(
    private readonly platform: UniFiSmartPowerHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.log = this.platform.log;
    this.context = <UniFiDisableControlPlatformAccessoryContext>this.accessory.context;
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
    this.disabled = !!value;
    if (!this.disabled && this.timeout > 0) {
      setTimeout(() => {
        // Ignore if it has already been re-disabled.
        if (this.disabled) {
          return;
        }
        this.disabled = true;
        this.log.debug(
          '[%s] Update Characteristic On due to enabled timeout ->',
          this.switchName,
          this.disabled,
        );
        this.onCharacteristic.updateValue(this.disabled);
      }, this.timeout * 1000);
    }
  }

  private getOn(): CharacteristicValue {
    this.log.debug('[%s] Get Characteristic On ->', this.switchName, this.disabled);
    return this.isDisabled();
  }

  public isDisabled() {
    return this.disabled;
  }
}
