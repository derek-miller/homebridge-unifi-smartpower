import { Characteristic, CharacteristicValue, HAP, Logger, PlatformAccessory } from 'homebridge';

import { UniFiSmartPowerHomebridgePlatform } from './platform';
import {
  UniFiDevice,
  UniFiDeviceKind,
  UniFiSwitchPort,
  UniFiPortOrOutletInUse,
  UniFiSmartPower,
  UniFiSmartPowerOutlet,
  UniFiSmartPowerOutletAction,
  UniFiSmartPowerOutletState,
  UniFiSwitchPortPoeMode,
  UniFiSwitchPortPoeModeAction,
} from './uniFiSmartPower';

export interface UniFiDevicePlatformAccessoryContext {
  device: UniFiDevice;
  isDisabled: () => boolean;
}

export class UniFiSmartPowerOutletPlatformAccessory {
  private readonly log: Logger;
  private readonly hap: HAP;
  private readonly uniFiSmartPower: UniFiSmartPower;
  private readonly context: UniFiDevicePlatformAccessoryContext;
  private readonly outletIndex: number;
  private readonly outletName: string;
  private readonly serialNumber: string;
  private readonly isDisabled: () => boolean;
  private readonly id: string;

  private status = UniFiSmartPowerOutletState.UNKNOWN;
  private inUse = UniFiPortOrOutletInUse.UNKNOWN;

  constructor(
    private readonly platform: UniFiSmartPowerHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly outlet: UniFiSmartPowerOutlet,
  ) {
    this.log = this.platform.log;
    this.hap = this.platform.api.hap;
    this.uniFiSmartPower = this.platform.uniFiSmartPower;
    this.context = <UniFiDevicePlatformAccessoryContext>this.accessory.context;
    this.serialNumber = this.context.device.serialNumber;
    this.outletIndex = this.outlet.index;
    this.outletName = this.outlet.name;
    this.isDisabled = this.context.isDisabled;
    this.id = `${this.serialNumber}.${this.outletIndex}`;

    const outletService = (this.accessory.getServiceById(this.platform.Service.Outlet, this.id) ||
      this.accessory.addService(this.platform.Service.Outlet, this.outletName, this.id))!
      .setCharacteristic(this.platform.Characteristic.Name, this.outletName)
      .setCharacteristic(this.platform.Characteristic.ConfiguredName, this.outletName);

    const statusCharacteristic = outletService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));
    const inUseCharacteristic: Characteristic | null =
      outlet.inUse !== UniFiPortOrOutletInUse.UNKNOWN
        ? outletService
            .getCharacteristic(this.platform.Characteristic.OutletInUse)
            .onGet(this.getInUse.bind(this))
        : null;

    this.uniFiSmartPower.subscribe(
      this.context.device,
      UniFiDeviceKind.OUTLET,
      this.outletIndex,
      (({ relayState, inUse }) => {
        if (this.status !== relayState && relayState !== UniFiSmartPowerOutletState.UNKNOWN) {
          this.log.debug(
            '[%s] Received outlet subscription status update: %s -> %s',
            this.outletName,
            UniFiSmartPowerOutletState[this.status],
            UniFiSmartPowerOutletState[relayState],
          );
          this.status = relayState;
          statusCharacteristic.updateValue(!!relayState);
        }
        if (
          inUseCharacteristic !== null &&
          this.inUse !== inUse &&
          inUse !== UniFiPortOrOutletInUse.UNKNOWN
        ) {
          this.log.debug(
            '[%s] Received outlet subscription InUse update: %s -> %s',
            this.outletName,
            UniFiPortOrOutletInUse[this.inUse],
            UniFiPortOrOutletInUse[inUse],
          );
          this.inUse = inUse;
          inUseCharacteristic.updateValue(!!inUse);
        }
      }) as (outlet: UniFiSmartPowerOutlet) => void,
    );
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    if (this.isDisabled()) {
      this.log.info('[%s] Cannot set Characteristic On when disabled', this.outletName);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
    }
    this.log.debug('[%s] Set Characteristic On ->', this.outletName, value);
    try {
      await this.uniFiSmartPower.commandOutlet(
        this.context.device,
        this.outletIndex,
        value ? UniFiSmartPowerOutletAction.ON : UniFiSmartPowerOutletAction.OFF,
      );
    } catch (error: unknown) {
      this.log.error(
        '[%s] An error occurred setting Characteristic On; %s',
        this.outletName,
        (<Error>error).message,
      );
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private getOn(): CharacteristicValue {
    if (this.status === UniFiSmartPowerOutletState.UNKNOWN) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    this.log.debug(
      '[%s] Get Characteristic On ->',
      this.outletName,
      UniFiSmartPowerOutletState[this.status],
    );
    return this.status === UniFiSmartPowerOutletState.ON;
  }

  private getInUse(): CharacteristicValue {
    if (this.inUse === UniFiPortOrOutletInUse.UNKNOWN) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    this.log.debug(
      '[%s] Get Characteristic InUse ->',
      this.outletName,
      UniFiPortOrOutletInUse[this.inUse],
    );
    return this.inUse === UniFiPortOrOutletInUse.YES;
  }
}

export class UniFiSwitchPortPlatformAccessory {
  private readonly log: Logger;
  private readonly hap: HAP;
  private readonly uniFiSmartPower: UniFiSmartPower;
  private readonly context: UniFiDevicePlatformAccessoryContext;
  private readonly portIndex: number;
  private readonly portName: string;
  private readonly portPoeOnAction: UniFiSwitchPortPoeModeAction;
  private readonly serialNumber: string;
  private readonly isDisabled: () => boolean;
  private readonly id: string;

  private poeMode: UniFiSwitchPortPoeMode = 'unknown';
  private inUse = UniFiPortOrOutletInUse.UNKNOWN;

  constructor(
    private readonly platform: UniFiSmartPowerHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly port: UniFiSwitchPort,
  ) {
    this.log = this.platform.log;
    this.hap = this.platform.api.hap;
    this.uniFiSmartPower = this.platform.uniFiSmartPower;
    this.context = <UniFiDevicePlatformAccessoryContext>this.accessory.context;
    this.serialNumber = this.context.device.serialNumber;
    this.portIndex = this.port.index;
    this.portName = this.port.name;
    this.portPoeOnAction = this.port.poeOnAction;
    this.isDisabled = this.context.isDisabled;
    this.id = `${this.serialNumber}.${this.portIndex}`;

    const outletService = (this.accessory.getServiceById(this.platform.Service.Outlet, this.id) ||
      this.accessory.addService(this.platform.Service.Outlet, this.portName, this.id))!
      .setCharacteristic(this.platform.Characteristic.Name, this.portName)
      .setCharacteristic(this.platform.Characteristic.ConfiguredName, this.portName);

    const statusCharacteristic = outletService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));
    const inUseCharacteristic: Characteristic | null =
      port.inUse !== UniFiPortOrOutletInUse.UNKNOWN
        ? outletService
            .getCharacteristic(this.platform.Characteristic.OutletInUse)
            .onGet(this.getInUse.bind(this))
        : null;

    this.uniFiSmartPower.subscribe(this.context.device, UniFiDeviceKind.PORT, this.portIndex, (({
      poeMode,
      inUse,
    }) => {
      if (this.poeMode !== poeMode && poeMode !== 'unknown') {
        this.log.debug(
          '[%s] Received port subscription status update: %s -> %s',
          this.portName,
          this.poeMode.toUpperCase(),
          poeMode.toUpperCase(),
        );
        this.poeMode = poeMode;
        statusCharacteristic.updateValue(this.poeMode !== 'off');
      }
      if (
        inUseCharacteristic !== null &&
        this.inUse !== inUse &&
        inUse !== UniFiPortOrOutletInUse.UNKNOWN
      ) {
        this.log.debug(
          '[%s] Received port subscription InUse update: %s -> %s',
          this.portName,
          UniFiPortOrOutletInUse[this.inUse],
          UniFiPortOrOutletInUse[inUse],
        );
        this.inUse = inUse;
        inUseCharacteristic.updateValue(!!inUse);
      }
    }) as (port: UniFiSwitchPort) => void);
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    if (this.isDisabled()) {
      this.log.info('[%s] Cannot set Characteristic On when disabled', this.portName);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
    }
    this.log.debug('[%s] Set Characteristic On ->', this.portName, value);
    try {
      await this.uniFiSmartPower.commandPort(
        this.context.device,
        this.portIndex,
        value ? this.portPoeOnAction : 'off',
      );
    } catch (error: unknown) {
      this.log.error(
        '[%s] An error occurred setting Characteristic On; %s',
        this.portName,
        (<Error>error).message,
      );
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private getOn(): CharacteristicValue {
    if (this.poeMode === 'unknown') {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    const isOn = this.poeMode !== 'off';
    this.log.debug('[%s] Get Characteristic On ->', this.portName, isOn ? 'ON' : 'OFF');
    return isOn;
  }

  private getInUse(): CharacteristicValue {
    if (this.inUse === UniFiPortOrOutletInUse.UNKNOWN) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    this.log.debug(
      '[%s] Get Characteristic InUse ->',
      this.portName,
      UniFiPortOrOutletInUse[this.inUse],
    );
    return this.inUse === UniFiPortOrOutletInUse.YES;
  }
}
