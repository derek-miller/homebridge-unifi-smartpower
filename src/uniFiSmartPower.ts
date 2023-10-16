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
  site: string;
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
  entry: UniFiApiDeviceOutletTable;
  override: UniFiApiDeviceOutletOverride;
}

export interface UniFiSwitchPort {
  index: number;
  name: string;
  poeMode: UniFiSwitchPortPoeMode;
  poeOnAction: UniFiSwitchPortPoeModeAction;
  inUse: UniFiPortOrOutletInUse;
  active: boolean;
  entry: UniFiApiDeviceSwitchPortTable;
  override: UniFiApiDeviceSwitchPortOverride;
}

export type UniFiSwitchPortPoeMode = 'unknown' | 'auto' | 'passthrough' | 'pasv24' | 'off';
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

export interface UniFiSite {
  id: string;
  name: string;
}

export class UniFiSmartPower {
  private static readonly PUB_SUB_OUTLET_TOPIC = 'outlet';

  private static readonly STATUS_CACHE_KEY = 'outlet-status';
  private static readonly STATUS_CACHE_TTL_MS_DEFAULT = 15 * 1000;
  private static readonly STATUS_CACHE_TTL_MS_MIN = 5 * 1000;
  private static readonly STATUS_CACHE_TTL_MS_MAX = 60 * 1000;

  private static readonly STATUS_POLL_INTERVAL_MS_DEFAULT = 15 * 1000;
  private static readonly STATUS_POLL_INTERVAL_MS_MIN = 5 * 1000;
  private static readonly STATUS_POLL_INTERVAL_MS_MAX = 60 * 1000;

  private static readonly CONTROLLER_LOCK = 'CONTROLLER_LOCK';

  private readonly lock = new AsyncLock({ domainReentrant: true });
  private readonly cache: Promise<Cache>;
  private readonly controller: Controller;

  constructor(
    public readonly log: Logger,
    private readonly config: UniFiControllerConfig,
  ) {
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
              // noinspection ExceptionCaughtLocallyJS
              throw new Error('unknown device status kind=%d', kind);
          }
        } catch (error: unknown) {
          // Nothing to do here. The error has already been logged.
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

  async getSites(): Promise<UniFiSite[]> {
    return this.lock.acquire(UniFiSmartPower.CONTROLLER_LOCK, async () => {
      this.log.debug('[API] Fetching sites from UniFi API');
      await this.controller.login();
      return (await this.controller.getSitesStats())
        .filter(({ name }) => !!name)
        .map(({ name: id, desc: name }) => ({
          id,
          name,
        }));
    });
  }

  async getDeviceStatuses(site: string, acquireLock?: boolean): Promise<UniFiDeviceStatus[]>;
  async getDeviceStatuses(device: UniFiDevice, acquireLock?: boolean): Promise<UniFiDeviceStatus[]>;

  async getDeviceStatuses(
    siteOrDevice: string | UniFiDevice,
    acquireLock = true,
  ): Promise<UniFiDeviceStatus[]> {
    let site: string;
    let device: UniFiDevice | null;
    let errMsg = '';
    if (typeof siteOrDevice === 'string') {
      site = siteOrDevice;
      errMsg = `site ${site} `;
      device = null;
    } else if (siteOrDevice) {
      device = siteOrDevice;
      site = device.site;
      errMsg = `device ${device.name} [${device.mac}] `;
    }
    const fetch = async (): Promise<UniFiDeviceStatus[]> => {
      const result: UniFiDeviceStatus[] | Error = await (
        await this.cache
      ).wrap(
        UniFiSmartPower.deviceCacheKey(device),
        async (): Promise<UniFiDeviceStatus[] | Error> => {
          this.log.debug('[API] Fetching status from UniFi API');
          this.controller.opts.site = site;
          let result: UniFiApiDevice[] = [],
            error: Error | null = null;
          try {
            await this.controller.login();
            result = await this.controller.getAccessDevices(device?.mac ?? '');
          } catch (e: unknown) {
            error = e as Error;
            this.log.error(
              '[API] An error occurred polling %sfor a status update; %s',
              errMsg,
              error.message,
            );
          }
          return (
            error ??
            result
              .filter(
                (device: UniFiApiDevice) =>
                  (device.outlet_table ?? []).length > 0 || (device.port_table ?? []).length > 0,
              )
              .map((device: UniFiApiDevice) =>
                UniFiSmartPower.transformDeviceStatusResponse(site, device),
              )
          );
        },
        this.statusCacheTtlMs,
      );
      if (result instanceof Error) {
        throw result;
      }
      return result;
    };
    return acquireLock ? this.lock.acquire(UniFiSmartPower.CONTROLLER_LOCK, fetch) : fetch();
  }

  private static transformDeviceStatusResponse(
    site: string,
    {
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
    }: UniFiApiDevice,
  ): UniFiDeviceStatus {
    return {
      device: {
        site,
        id,
        ip,
        mac,
        model,
        version,
        serialNumber,
        name: name || model || serialNumber,
      },
      ports: (
        ports
          ?.filter(({ port_poe: isPoePort }) => !!isPoePort)
          .map(
            (entry: UniFiApiDeviceSwitchPortTable): UniFiSwitchPort => ({
              index: entry.port_idx,
              name: entry.name ?? `Port ${entry.port_idx}`,
              poeMode: entry.poe_mode || 'off',
              inUse: !entry.poe_power ? -1 : parseFloat(entry.poe_power) > 0 ? 1 : 0,
              active: !!entry.poe_enable,
              poeOnAction: this.getPortPoeOnMode(entry.poe_caps),
              entry,
              override:
                portOverrides?.find((p) => p?.port_idx === entry.port_idx) ??
                (Object.fromEntries(
                  Object.entries(entry).filter(([k]) =>
                    ['port_idx', 'name', 'poe_mode', 'portconf_id'].includes(k),
                  ),
                ) as UniFiApiDeviceSwitchPortOverride),
            }),
          ) ?? []
      ).filter((p) => p.poeOnAction !== 'off' && p.override && p.entry),
      outlets: (
        outlets?.map(
          (entry: UniFiApiDeviceOutletTable): UniFiSmartPowerOutlet => ({
            index: entry.index,
            name: entry.name ?? `Outlet ${entry.index}`,
            relayState: entry.relay_state ? 1 : 0,
            inUse: !entry.outlet_power ? -1 : parseFloat(entry.outlet_power) > 0 ? 1 : 0,
            entry,
            override:
              outletOverrides?.find((o) => o?.index === entry.index) ??
              (Object.fromEntries(
                Object.entries(entry).filter(([k]) => ['index', 'name', 'relay_state'].includes(k)),
              ) as UniFiApiDeviceOutletOverride),
          }),
        ) ?? []
      ).filter((o) => o.override && o.entry),
    };
  }

  private static getPortPoeOnMode(
    poeCaps: number | null | undefined,
  ): UniFiSwitchPortPoeModeAction {
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

  private static poeSupportsMode(poeCaps: number | null | undefined, cap: number): boolean {
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
    return this.lock.acquire(UniFiSmartPower.CONTROLLER_LOCK, async () => {
      const { outlets } = await this.getDeviceStatus(device, false);
      this.controller.opts.site = device.site;
      await this.controller.login();
      await this.controller.setDeviceSettingsBase(device.id, {
        outlet_overrides: outlets.map((outlet) => ({
          ...outlet.override,
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
    return this.lock.acquire(UniFiSmartPower.CONTROLLER_LOCK, async () => {
      const { ports } = await this.getDeviceStatus(device, false);
      this.controller.opts.site = device.site;
      await this.controller.login();
      await this.controller.setDeviceSettingsBase(device.id, {
        port_overrides: ports.map((port) => ({
          ...port.override,
          poe_mode: port.index === portIndex ? poeMode : port.poeMode,
        })),
      });
      await (await this.cache).del(UniFiSmartPower.deviceCacheKey(device));
      await (await this.cache).del(UniFiSmartPower.deviceCacheKey());
    });
  }

  private get statusCacheTtlMs(): number {
    return Math.max(
      UniFiSmartPower.STATUS_CACHE_TTL_MS_MIN,
      Math.min(
        UniFiSmartPower.STATUS_CACHE_TTL_MS_MAX,
        (this.config.outletStatusCacheTtl ?? 0) * 1000 ||
          UniFiSmartPower.STATUS_CACHE_TTL_MS_DEFAULT,
      ),
    );
  }

  private get statusPollIntervalMs(): number {
    return Math.max(
      UniFiSmartPower.STATUS_POLL_INTERVAL_MS_MIN,
      Math.min(
        UniFiSmartPower.STATUS_POLL_INTERVAL_MS_MAX,
        (this.config.outletStatusPollInterval ?? 0) * 1000 ||
          UniFiSmartPower.STATUS_POLL_INTERVAL_MS_DEFAULT,
      ),
    );
  }

  private static statusTopic(device: UniFiDevice, kind: UniFiDeviceKind, index: number): string {
    return `${UniFiSmartPower.PUB_SUB_OUTLET_TOPIC}.${device.id}.${kind}.${index}`;
  }

  private static deviceCacheKey(device: UniFiDevice | null = null): string {
    return `${UniFiSmartPower.STATUS_CACHE_KEY}.${device?.id ?? 'ALL'}`;
  }
}

type UniFiApiDevice = {
  _id: string;
  ip: string;
  mac: string;
  model: string;
  version: string;
  serial: string;
  name?: string;
  port_table: UniFiApiDeviceSwitchPortTable[] | null | undefined;
  port_overrides: UniFiApiDeviceSwitchPortOverride[] | null | undefined;
  outlet_table: UniFiApiDeviceOutletTable[] | null | undefined;
  outlet_overrides: UniFiApiDeviceOutletOverride[] | null | undefined;
};

type UniFiApiDeviceSwitchPortTable = {
  port_idx: number;
  name?: string;
  port_poe?: boolean;
  poe_mode?: UniFiSwitchPortPoeModeAction;
  poe_caps?: number;
  poe_power?: string;
  poe_enable?: boolean;
  // many others
};

type UniFiApiDeviceSwitchPortOverride = {
  port_idx: number;
  name?: string;
  poe_mode: UniFiSwitchPortPoeModeAction;
};

type UniFiApiDeviceOutletTable = {
  index: number;
  name?: string;
  relay_state: boolean;
  outlet_power?: string;
  outlet_caps?: number;
};

type UniFiApiDeviceOutletOverride = {
  index: number;
  name?: string;
  relay_state: boolean;
};
