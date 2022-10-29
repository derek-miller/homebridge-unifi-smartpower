import PubSub from 'pubsub-js';
import { Logger } from 'homebridge';

import { Cache, caching } from 'cache-manager';
import AsyncLock from 'async-lock';
import Token = PubSubJS.Token;
import { Controller } from 'node-unifi';

export interface UniFiSmartPowerStatus {
  device: UniFiSmartPowerDevice;
  outlets: UniFiSmartPowerOutlet[];
}

export interface UniFiSmartPowerDevice {
  id: string;
  ip: string;
  mac: string;
  model: string;
  version: string;
  serialNumber: string;
  name: string;
}

export interface UniFiSmartPowerOutlet {
  index: number;
  name: string;
  relayState: UniFiSmartPowerOutletState;
  modemPowerCycleState: UniFiSmartPowerOutletState;
  inUse: UniFiSmartPowerOutletInUse;
}

export enum UniFiSmartPowerOutletState {
  UNKNOWN = -1,
  OFF = 0,
  ON = 1,
}

export enum UniFiSmartPowerOutletInUse {
  UNKNOWN = -1,
  NO = 0,
  YES = 1,
}

export enum UniFiSmartPowerOutletAction {
  OFF = 0,
  ON = 1,
}

export interface UniFiSmartPowerConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  refreshDevicesPollInterval?: number;
  outletStatusPollInterval?: number;
  outletStatusCacheTtl?: number;
}

export class UniFiSmartPower {
  private static readonly PUB_SUB_OUTLET_TOPIC = 'outlet';

  private static readonly OUTLET_STATUS_CACHE_KEY = 'outlet-status';
  private static readonly OUTLET_STATUS_CACHE_TTL_S_DEFAULT = 15;
  private static readonly OUTLET_STATUS_CACHE_TTL_S_MIN = 5;
  private static readonly OUTLET_STATUS_CACHE_TTL_S_MAX = 60;

  private static readonly OUTLET_STATUS_POLL_INTERVAL_S_DEFAULT = 15;
  private static readonly OUTLET_STATUS_POLL_INTERVAL_S_MIN = 5;
  private static readonly OUTLET_STATUS_POLL_INTERVAL_S_MAX = 60;

  private static readonly OUTLET_STATUS_LOCK = 'OUTLET_STATUS';

  private readonly lock = new AsyncLock({ domainReentrant: true });
  private readonly cache: Promise<Cache>;
  private readonly controller: Controller;

  constructor(public readonly log: Logger, private readonly config: UniFiSmartPowerConfig) {
    this.cache = caching('memory', {
      ttl: 0, // No default ttl
      max: 0, // Infinite capacity
    });
    this.controller = new Controller({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
      sslverify: false,
    });
  }

  reset(): void {
    PubSub.clearAllSubscriptions();
  }

  subscribe(
    device: UniFiSmartPowerDevice,
    outletIndex: number,
    func: (outlet: UniFiSmartPowerOutlet) => void,
  ): Token {
    const topic = UniFiSmartPower.outletStatusTopic(device, outletIndex);
    const token = PubSub.subscribe(topic, async (_, data) => {
      if (!data) {
        return;
      }
      func(data);
    });
    this.log.debug(
      '[API] Status subscription added for outlet %s.%s [token=%s]',
      device.mac,
      outletIndex,
      token,
    );

    // When this is the first subscription, start polling to publish updates.
    if (PubSub.countSubscriptions(topic) === 1) {
      const poll = async () => {
        // Stop polling when there are no active subscriptions.
        if (PubSub.countSubscriptions(topic) === 0) {
          this.log.debug('[API] There are no outlet status subscriptions; skipping poll');
          return;
        }
        // Acquire the status lock before emitting any new events.
        this.log.debug('[API] Polling status for outlet %s.%s', device.mac, outletIndex);
        try {
          PubSub.publish(topic, await this.getOutletStatus(device, outletIndex));
        } catch (error: unknown) {
          if (error instanceof Error) {
            this.log.error(
              '[API] An error occurred polling for a status update; %s',
              error.message,
            );
          }
        }
        setTimeout(poll, this.outletStatusPollIntervalMs);
      };
      setTimeout(poll, 0);
    }
    return token;
  }

  unsubscribe(token: Token): void {
    PubSub.unsubscribe(token);
    this.log.debug('[API] Status subscription removed for token %s', token);
  }

  async getDeviceStatuses(
    device: UniFiSmartPowerDevice | null = null,
    acquireLock = true,
  ): Promise<UniFiSmartPowerStatus[]> {
    const fetch = async (): Promise<UniFiSmartPowerStatus[]> =>
      (await this.cache).wrap(
        UniFiSmartPower.outletStatusesCacheKey(device),
        async (): Promise<UniFiSmartPowerStatus[]> => {
          this.log.debug('[API] Fetching status from UniFi API');
          await this.controller.login();
          return (await this.controller.getAccessDevices(device?.mac ?? ''))
            .filter((device) => (device.outlet_table ?? []).length > 0)
            .map((device) => UniFiSmartPower.transformDeviceStatusResponse(device));
        },
        this.outletStatusCacheTtl,
      );
    return acquireLock ? this.lock.acquire(UniFiSmartPower.OUTLET_STATUS_LOCK, fetch) : fetch();
  }

  static transformDeviceStatusResponse({
    _id: id,
    ip,
    mac,
    model,
    version,
    serial: serialNumber,
    name,
    outlet_table: outlets,
  }): UniFiSmartPowerStatus {
    return {
      device: {
        id,
        ip,
        mac,
        model,
        version,
        serialNumber,
        name,
      },
      outlets:
        outlets?.map(
          ({
            index,
            name,
            relay_state: relayState,
            cycle_enable: modemPowerCycleState,
            outlet_power: power = null,
          }) => ({
            index,
            name,
            relayState: relayState ? 1 : 0,
            modemPowerCycleState: modemPowerCycleState ? 1 : 0,
            inUse: power === null ? -1 : parseFloat(power) > 0 ? 1 : 0,
          }),
        ) ?? [],
    };
  }

  async getDeviceStatus(
    device: UniFiSmartPowerDevice,
    acquireLock = true,
  ): Promise<UniFiSmartPowerStatus> {
    const devices = await this.getDeviceStatuses(device, acquireLock);
    if (devices.length !== 1) {
      throw new Error(`unknown device with id=${device.id}`);
    }
    return devices[0];
  }

  async getOutletStatus(
    device: UniFiSmartPowerDevice,
    outletIndex: number,
  ): Promise<UniFiSmartPowerOutlet> {
    const { outlets } = await this.getDeviceStatus(device);
    const outletInfo = outlets.find(({ index }) => index === outletIndex) ?? null;
    if (outletInfo === null) {
      throw new Error(`unknown outlet with id=${outletIndex}`);
    }
    return outletInfo;
  }

  async commandOutlet(
    device: UniFiSmartPowerDevice,
    outletIndex: number,
    command: UniFiSmartPowerOutletAction,
  ): Promise<void> {
    return this.lock.acquire(UniFiSmartPower.OUTLET_STATUS_LOCK, async () => {
      const { outlets } = await this.getDeviceStatus(device, false);
      await this.controller.setDeviceSettingsBase(device.id, {
        outlet_overrides: outlets.map((outlet) => ({
          index: outlet.index,
          name: outlet.name,
          relay_state: outlet.index === outletIndex ? !!command : !!outlet.relayState,
          cycle_enable: !!outlet.modemPowerCycleState,
        })),
      });
      await (await this.cache).del(UniFiSmartPower.outletStatusesCacheKey(device));
      await (await this.cache).del(UniFiSmartPower.outletStatusesCacheKey());
    });
  }

  private get outletStatusCacheTtl(): number {
    return Math.max(
      UniFiSmartPower.OUTLET_STATUS_CACHE_TTL_S_MIN,
      Math.min(
        UniFiSmartPower.OUTLET_STATUS_CACHE_TTL_S_MAX,
        this.config.outletStatusCacheTtl ?? UniFiSmartPower.OUTLET_STATUS_CACHE_TTL_S_DEFAULT,
      ),
    );
  }

  private get outletStatusPollIntervalMs(): number {
    return (
      Math.max(
        UniFiSmartPower.OUTLET_STATUS_POLL_INTERVAL_S_MIN,
        Math.min(
          UniFiSmartPower.OUTLET_STATUS_POLL_INTERVAL_S_MAX,
          this.config.outletStatusPollInterval ??
            UniFiSmartPower.OUTLET_STATUS_POLL_INTERVAL_S_DEFAULT,
        ),
      ) * 1000
    );
  }

  private static outletStatusTopic(device: UniFiSmartPowerDevice, outletIndex: number): string {
    return `${UniFiSmartPower.PUB_SUB_OUTLET_TOPIC}.${device.id}.${outletIndex}`;
  }

  private static outletStatusesCacheKey(device: UniFiSmartPowerDevice | null = null): string {
    return `${UniFiSmartPower.OUTLET_STATUS_CACHE_KEY}.${device?.id ?? 'ALL'}`;
  }
}
