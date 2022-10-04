import { Characteristic, CharacteristicValue, HAP, Logger, PlatformAccessory } from 'homebridge';

import { UniFiSmartPowerHomebridgePlatform } from './platform';
import {
  UniFiSmartPower,
  UniFiSmartPowerDevice,
  UniFiSmartPowerOutlet,
  UniFiSmartPowerOutletAction,
  UniFiSmartPowerOutletInUse,
  UniFiSmartPowerOutletState,
} from './uniFiSmartPower';

export interface UniFiSmartPowerOutletPlatformAccessoryContext {
  device: UniFiSmartPowerDevice;
}

export class UniFiSmartPowerOutletPlatformAccessory {
  private readonly log: Logger;
  private readonly hap: HAP;
  private readonly uniFiSmartPower: UniFiSmartPower;
  private readonly context: UniFiSmartPowerOutletPlatformAccessoryContext;
  private readonly outletIndex: number;
  private readonly outletName: string;
  private readonly serialNumber: string;
  private readonly id: string;

  private status = UniFiSmartPowerOutletState.UNKNOWN;
  private inUse = UniFiSmartPowerOutletInUse.UNKNOWN;

  constructor(
    private readonly platform: UniFiSmartPowerHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly outlet: UniFiSmartPowerOutlet,
  ) {
    this.log = this.platform.log;
    this.hap = this.platform.api.hap;
    this.uniFiSmartPower = this.platform.uniFiSmartPower;
    this.context = <UniFiSmartPowerOutletPlatformAccessoryContext>this.accessory.context;
    this.serialNumber = this.context.device.serialNumber;
    this.outletIndex = this.outlet.index;
    this.outletName = this.outlet.name;
    this.id = `${this.serialNumber}.${this.outletIndex}`;

    const outletService = (this.accessory.getServiceById(this.platform.Service.Outlet, this.id) ||
      this.accessory.addService(
        this.platform.Service.Outlet,
        this.outletName,
        this.id,
      ))!.setCharacteristic(this.platform.Characteristic.Name, this.outletName);

    const statusCharacteristic = outletService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));
    const inUseCharacteristic: Characteristic | null =
      outlet.inUse !== UniFiSmartPowerOutletInUse.UNKNOWN
        ? outletService
            .getCharacteristic(this.platform.Characteristic.InUse)
            .onGet(this.getInUse.bind(this))
        : null;

    this.uniFiSmartPower.subscribe(
      this.context.device,
      this.outletIndex,
      ({ relayState, inUse }) => {
        if (this.status !== relayState) {
          this.log.debug(
            '[%s] Received outlet subscription status update: %s -> %s',
            this.outletName,
            UniFiSmartPowerOutletState[this.status],
            UniFiSmartPowerOutletState[relayState],
          );
          this.status = relayState;
          statusCharacteristic.updateValue(!!relayState);
        }
        if (inUseCharacteristic !== null && this.inUse !== inUse) {
          this.log.debug(
            '[%s] Received outlet subscription InUse update: %s -> %s',
            this.outletName,
            UniFiSmartPowerOutletInUse[this.inUse],
            UniFiSmartPowerOutletInUse[inUse],
          );
          this.inUse = inUse;
          inUseCharacteristic.updateValue(!!inUse);
        }
      },
    );
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
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
    return !!this.status;
  }

  private getInUse(): CharacteristicValue {
    if (this.status === UniFiSmartPowerOutletState.UNKNOWN) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    this.log.debug(
      '[%s] Get Characteristic InUse ->',
      this.outletName,
      UniFiSmartPowerOutletState[this.status],
    );
    return !!this.status;
  }
}
