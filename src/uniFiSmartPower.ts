import PubSub from 'pubsub-js';
import { Logger } from 'homebridge';

import { Cache, caching } from 'cache-manager';
import AsyncLock from 'async-lock';
import Token = PubSubJS.Token;
import { Controller } from 'node-unifi';

export interface UniFiDeviceStatus {
  device: UniFiDevice;
  ports: UniFiSwitchPort[];
  outlets: UniFiSmartPowerOutlet[];
}

export interface UniFiDevice {
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
  inUse: UniFiPortOrOutletInUse;
  entry: { [k: string]: never };
  overrides: { [k: string]: never };
}

export interface UniFiSwitchPort {
  index: number;
  name: string;
  poeMode: UniFiSwitchPortPoeMode;
  poeOnAction: UniFiSwitchPortPoeModeAction;
  inUse: UniFiPortOrOutletInUse;
  active: boolean;
  entry: { [k: string]: never };
  overrides: { [k: string]: never };
}

export type UniFiSwitchPortPoeMode = 'unknown' | 'auto' | 'passthrough' | 'off';
export type UniFiSwitchPortPoeModeAction = 'auto' | 'passthrough' | 'pasv24' | 'off';

export enum UniFiSmartPowerOutletState {
  UNKNOWN = -1,
  OFF = 0,
  ON = 1,
}

export enum UniFiPortOrOutletInUse {
  UNKNOWN = -1,
  NO = 0,
  YES = 1,
}

export enum UniFiSmartPowerOutletAction {
  OFF = 0,
  ON = 1,
}

export enum UniFiDeviceKind {
  OUTLET = 0,
  PORT = 1,
}

export const UniFiSwitchPortPoeCaps = {
  '8023AF': 1,
  '8023AT': 2,
  PASV24: 4,
  PASSTHROUGHABLE: 8,
  PASSTHROUGH: 16,
  '8023BT': 32,
};

export interface UniFiControllerConfig {
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

  private static readonly STATUS_CACHE_KEY = 'outlet-status';
  private static readonly STATUS_CACHE_TTL_S_DEFAULT = 15;
  private static readonly STATUS_CACHE_TTL_S_MIN = 5;
  private static readonly STATUS_CACHE_TTL_S_MAX = 60;

  private static readonly STATUS_POLL_INTERVAL_S_DEFAULT = 15;
  private static readonly STATUS_POLL_INTERVAL_S_MIN = 5;
  private static readonly STATUS_POLL_INTERVAL_S_MAX = 60;

  private static readonly DEVICE_STATUS_LOCK = 'OUTLET_STATUS';

  private readonly lock = new AsyncLock({ domainReentrant: true });
  private readonly cache: Promise<Cache>;
  private readonly controller: Controller;

  constructor(public readonly log: Logger, private readonly config: UniFiControllerConfig) {
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
    device: UniFiDevice,
    kind: UniFiDeviceKind,
    index: number,
    func: ((outlet: UniFiSmartPowerOutlet) => void) | ((port: UniFiSwitchPort) => void),
  ): Token {
    const topic = UniFiSmartPower.statusTopic(device, kind, index);
    const token = PubSub.subscribe(topic, async (_, data) => {
      if (!data) {
        return;
      }
      func(data);
    });
    this.log.debug(
      '[API] Status subscription added for %s %s.%s [token=%s]',
      kind === UniFiDeviceKind.PORT ? 'port' : 'outlet',
      device.mac,
      index,
      token,
    );

    // When this is the first subscription, start polling to publish updates.
    if (PubSub.countSubscriptions(topic) === 1) {
      const poll = async () => {
        // Stop polling when there are no active subscriptions.
        if (PubSub.countSubscriptions(topic) === 0) {
          this.log.debug('[API] There are no status subscriptions; skipping poll');
          return;
        }
        // Acquire the status lock before emitting any new events.
        try {
          switch (kind) {
            case UniFiDeviceKind.OUTLET:
              this.log.debug('[API] Polling status for outlet %s.%s', device.mac, index);
              PubSub.publish(topic, await this.getOutletStatus(device, index));
              break;
            case UniFiDeviceKind.PORT:
              this.log.debug('[API] Polling status for port %s.%s', device.mac, index);
              PubSub.publish(topic, await this.getPortStatus(device, index));
              break;
            default:
              throw new Error('unknown device status kind=%d', kind);
          }
        } catch (error: unknown) {
          if (error instanceof Error) {
            this.log.error(
              '[API] An error occurred polling for a status update; %s',
              error.message,
            );
          }
        }
        setTimeout(poll, this.statusPollIntervalMs);
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
    device: UniFiDevice | null = null,
    acquireLock = true,
  ): Promise<UniFiDeviceStatus[]> {
    const fetch = async (): Promise<UniFiDeviceStatus[]> =>
      (await this.cache).wrap(
        UniFiSmartPower.deviceCacheKey(device),
        async (): Promise<UniFiDeviceStatus[]> => {
          this.log.debug('[API] Fetching status from UniFi API');
          await this.controller.login();
          return (await this.controller.getAccessDevices(device?.mac ?? ''))
            .filter(
              (device) =>
                (device.outlet_table ?? []).length > 0 || (device.port_table ?? []).length > 0,
            )
            .map((device) => UniFiSmartPower.transformDeviceStatusResponse(device));
        },
        this.statusCacheTtl,
      );
    return acquireLock ? this.lock.acquire(UniFiSmartPower.DEVICE_STATUS_LOCK, fetch) : fetch();
  }

  static transformDeviceStatusResponse({
    _id: id,
    ip,
    mac,
    model,
    version,
    serial: serialNumber,
    name,
    port_table: ports,
    port_overrides: portOverrides,
    outlet_table: outlets,
    outlet_overrides: outletOverrides,
  }): UniFiDeviceStatus {
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
      ports: (
        ports
          ?.filter(({ port_poe: isPoePort }) => isPoePort)
          .map(
            ({
              port_idx: index,
              name,
              poe_mode: poeMode,
              poe_caps: poeCaps = null,
              poe_power: poePower = null,
              poe_enable: poeEnabled = null,
            }) =>
              ({
                index,
                name,
                poeMode,
                inUse: poePower === null ? -1 : parseFloat(poePower) > 0 ? 1 : 0,
                active: !!poeEnabled,
                poeOnAction: this.getPortPoeOnMode(poeCaps),
                entry: ports.find((p) => p?.port_idx === index),
                overrides: portOverrides.find((p) => p?.port_idx === index),
              } as UniFiSwitchPort),
          ) ?? []
      ).filter((p) => p.poeOnAction !== 'off' && p.overrides && p.entry),
      outlets: (
        outlets?.map(
          ({ index, name, relay_state: relayState, outlet_power: power = null }) =>
            ({
              index,
              name,
              relayState: relayState ? 1 : 0,
              inUse: power === null ? -1 : parseFloat(power) > 0 ? 1 : 0,
              entry: outlets.find((o) => o?.index === index),
              overrides: outletOverrides.find((o) => o?.index === index),
            } as UniFiSmartPowerOutlet),
        ) ?? []
      ).filter((o) => o.overrides && o.entry),
    };
  }

  static getPortPoeOnMode(poeCaps: number | null | undefined): UniFiSwitchPortPoeModeAction | null {
    if (
      // We already filter out non-poe ports and if it doesn't have cps then it supports auto
      poeCaps === undefined ||
      poeCaps === null ||
      this.poeSupportsMode(poeCaps, UniFiSwitchPortPoeCaps['8023AF']) ||
      this.poeSupportsMode(poeCaps, UniFiSwitchPortPoeCaps['8023AT']) ||
      this.poeSupportsMode(poeCaps, UniFiSwitchPortPoeCaps['8028023BT3AF'])
    ) {
      return 'auto';
    }
    if (
      this.poeSupportsMode(poeCaps, UniFiSwitchPortPoeCaps.PASSTHROUGH) ||
      this.poeSupportsMode(poeCaps, UniFiSwitchPortPoeCaps.PASSTHROUGHABLE)
    ) {
      return 'passthrough';
    }
    if (this.poeSupportsMode(poeCaps, UniFiSwitchPortPoeCaps.PASV24)) {
      return 'pasv24';
    }
    return 'off';
  }

  static poeSupportsMode(poeCaps: number | null | undefined, cap: number): boolean {
    return !!poeCaps && (poeCaps & cap) === cap;
  }

  async getDeviceStatus(device: UniFiDevice, acquireLock = true): Promise<UniFiDeviceStatus> {
    const devices = await this.getDeviceStatuses(device, acquireLock);
    if (devices.length !== 1) {
      throw new Error(`unknown device with id=${device.id}`);
    }
    return devices[0];
  }

  async getPortStatus(device: UniFiDevice, portIndex: number): Promise<UniFiSwitchPort> {
    const { ports } = await this.getDeviceStatus(device);
    const portInfo = ports.find(({ index }) => index === portIndex) ?? null;
    if (portInfo === null) {
      throw new Error(`unknown port with id=${portIndex}`);
    }
    return portInfo;
  }

  async getOutletStatus(device: UniFiDevice, outletIndex: number): Promise<UniFiSmartPowerOutlet> {
    const { outlets } = await this.getDeviceStatus(device);
    const outletInfo = outlets.find(({ index }) => index === outletIndex) ?? null;
    if (outletInfo === null) {
      throw new Error(`unknown outlet with id=${outletIndex}`);
    }
    return outletInfo;
  }

  async commandOutlet(
    device: UniFiDevice,
    outletIndex: number,
    command: UniFiSmartPowerOutletAction,
  ): Promise<void> {
    return this.lock.acquire(UniFiSmartPower.DEVICE_STATUS_LOCK, async () => {
      const { outlets } = await this.getDeviceStatus(device, false);
      await this.controller.setDeviceSettingsBase(device.id, {
        outlet_overrides: outlets.map((outlet) => ({
          ...outlet.overrides,
          relay_state: outlet.index === outletIndex ? !!command : !!outlet.relayState,
        })),
      });
      await (await this.cache).del(UniFiSmartPower.deviceCacheKey(device));
      await (await this.cache).del(UniFiSmartPower.deviceCacheKey());
    });
  }

  async commandPort(
    device: UniFiDevice,
    portIndex: number,
    poeMode: UniFiSwitchPortPoeModeAction,
  ): Promise<void> {
    return this.lock.acquire(UniFiSmartPower.DEVICE_STATUS_LOCK, async () => {
      const { ports } = await this.getDeviceStatus(device, false);
      await this.controller.setDeviceSettingsBase(device.id, {
        port_overrides: ports.map((port) => ({
          ...port.overrides,
          poe_mode: port.index === portIndex ? poeMode : port.poeMode,
        })),
      });
      await (await this.cache).del(UniFiSmartPower.deviceCacheKey(device));
      await (await this.cache).del(UniFiSmartPower.deviceCacheKey());
    });
  }

  private get statusCacheTtl(): number {
    return Math.max(
      UniFiSmartPower.STATUS_CACHE_TTL_S_MIN,
      Math.min(
        UniFiSmartPower.STATUS_CACHE_TTL_S_MAX,
        this.config.outletStatusCacheTtl ?? UniFiSmartPower.STATUS_CACHE_TTL_S_DEFAULT,
      ),
    );
  }

  private get statusPollIntervalMs(): number {
    return (
      Math.max(
        UniFiSmartPower.STATUS_POLL_INTERVAL_S_MIN,
        Math.min(
          UniFiSmartPower.STATUS_POLL_INTERVAL_S_MAX,
          this.config.outletStatusPollInterval ?? UniFiSmartPower.STATUS_POLL_INTERVAL_S_DEFAULT,
        ),
      ) * 1000
    );
  }

  private static statusTopic(device: UniFiDevice, kind: UniFiDeviceKind, index: number): string {
    return `${UniFiSmartPower.PUB_SUB_OUTLET_TOPIC}.${device.id}.${kind}.${index}`;
  }

  private static deviceCacheKey(device: UniFiDevice | null = null): string {
    return `${UniFiSmartPower.STATUS_CACHE_KEY}.${device?.id ?? 'ALL'}`;
  }
}
