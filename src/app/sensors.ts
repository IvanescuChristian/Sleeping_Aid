// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import type { MotionSample } from '../engine/types';
import { isNativeAndroid } from '../native/plugin';
import { parseHeartRate } from './hr';

// ---------- Motion ----------

export type MotionState = 'off' | 'waiting' | 'ok' | 'none' | 'denied';

/** Max accepted rate; the stager needs far less, and a lower rate saves battery. */
const MOTION_MIN_INTERVAL_MS = 100;

export class MotionSensor {
  state: MotionState = 'off';
  hz = 0;
  private count = 0;
  private windowStart = 0;
  private last = 0;
  private startedAt = 0;
  private listener: ((e: DeviceMotionEvent) => void) | null = null;

  /** Asks permission where the platform requires it (a user gesture is needed there). */
  static async requestPermission(): Promise<boolean> {
    const D = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    if (!D) return false;
    if (typeof D.requestPermission === 'function') {
      try {
        return (await D.requestPermission()) === 'granted';
      } catch {
        return false;
      }
    }
    return true;
  }

  start(onSample: (s: MotionSample) => void, now: () => number = Date.now): void {
    if (this.listener) return;
    this.state = 'waiting';
    this.startedAt = now();
    this.windowStart = this.startedAt;
    this.listener = (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x === null || a.y === null || a.z === null) return;
      const t = now();
      if (t - this.last < MOTION_MIN_INTERVAL_MS) return;
      this.last = t;
      this.count++;
      this.state = 'ok';
      // Handlers only append to the aggregator; all heavy work happens on the 1 s tick.
      onSample({ t, ax: a.x, ay: a.y, az: a.z });
    };
    window.addEventListener('devicemotion', this.listener);
  }

  /** Called from the 1 s tick; keeps the rate figure fresh and flags a silent sensor. */
  refresh(t: number): void {
    if (!this.listener) return;
    const dt = t - this.windowStart;
    if (dt >= 5000) {
      this.hz = Math.round((this.count / (dt / 1000)) * 10) / 10;
      this.count = 0;
      this.windowStart = t;
      if (this.hz === 0 && t - this.startedAt >= 5000) this.state = 'none';
    }
  }

  stop(): void {
    if (this.listener) window.removeEventListener('devicemotion', this.listener);
    this.listener = null;
    this.state = 'off';
    this.hz = 0;
  }
}

// ---------- Heart rate over Web Bluetooth ----------

interface BtCharacteristic extends EventTarget {
  value?: DataView;
  startNotifications(): Promise<BtCharacteristic>;
}
interface BtService {
  getCharacteristic(c: string): Promise<BtCharacteristic>;
}
interface BtServer {
  connected: boolean;
  connect(): Promise<BtServer>;
  disconnect(): void;
  getPrimaryService(s: string): Promise<BtService>;
}
interface BtDevice extends EventTarget {
  name?: string;
  gatt?: BtServer;
}
interface BtApi {
  requestDevice(o: { filters: Array<{ services: string[] }> }): Promise<BtDevice>;
}

export type HrState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

const HR_STALE_MS = 20_000;

export class HeartRateMonitor {
  state: HrState = 'idle';
  deviceName: string | null = null;
  bpm: number | null = null;
  lastAt = 0;
  error: string | null = null;
  onSample: ((bpm: number, t: number) => void) | null = null;
  onChange: (() => void) | null = null;
  private device: BtDevice | null = null;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;

  static supported(): boolean {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator && !!(navigator as unknown as { bluetooth?: unknown }).bluetooth;
  }

  /** Current value, or null when the stream has gone quiet. */
  current(now: number = Date.now()): number | null {
    return this.bpm !== null && now - this.lastAt < HR_STALE_MS ? this.bpm : null;
  }

  /** Must run from a user gesture (device chooser). */
  async connect(): Promise<void> {
    const bt = (navigator as unknown as { bluetooth?: BtApi }).bluetooth;
    if (!bt) throw new Error('Web Bluetooth is not available');
    this.closed = false;
    this.setState('connecting');
    try {
      const device = await bt.requestDevice({ filters: [{ services: ['heart_rate'] }] });
      this.device = device;
      this.deviceName = device.name ?? 'Heart rate sensor';
      device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());
      await this.attach();
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'connection failed';
      this.setState('error');
      throw err;
    }
  }

  disconnect(): void {
    this.closed = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    try {
      if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    } catch {
      /* already gone */
    }
    this.setState('idle');
  }

  private async attach(): Promise<void> {
    const server = await this.device?.gatt?.connect();
    if (!server) throw new Error('GATT server unavailable');
    const service = await server.getPrimaryService('heart_rate');
    const ch = await service.getCharacteristic('heart_rate_measurement');
    ch.addEventListener('characteristicvaluechanged', (e) => {
      const dv = (e.target as unknown as BtCharacteristic).value;
      if (!dv) return;
      const bpm = parseHeartRate(dv);
      if (bpm === null) return;
      const t = Date.now();
      this.bpm = bpm;
      this.lastAt = t;
      this.onSample?.(bpm, t);
    });
    await ch.startNotifications();
    this.retries = 0;
    this.error = null;
    this.setState('connected');
  }

  private handleDisconnect(): void {
    if (this.closed) return;
    this.setState('reconnecting');
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(this.retries, 4));
    this.retries++;
    this.retry = setTimeout(() => {
      this.attach().catch(() => this.handleDisconnect());
    }, delay);
  }

  private setState(s: HrState): void {
    this.state = s;
    try {
      this.onChange?.();
    } catch {
      /* UI error must not affect the monitor */
    }
  }
}

// ---------- Heart rate from the Wear OS watch ----------

/** The watch delivers heart rate in batches roughly every 30 s, so "fresh" is much longer than for a live BLE stream. */
const WATCH_HR_STALE_MS = 150_000;

/**
 * Heart rate relayed by the watch app. It plugs into NightSession exactly where the Bluetooth monitor does:
 * the session sets `onSample` and reads `current()`, `state` and `disconnect()`. The feed (src/native/watch.ts)
 * calls `push()` for every sample.
 */
export class WatchHeartRate extends HeartRateMonitor {
  constructor() {
    super();
    this.deviceName = 'Wear OS watch';
  }

  /** `t` is the (already shifted) sample time for the stager; `receivedAt` is the phone clock when it arrived. */
  push(bpm: number, t: number, receivedAt: number = Date.now()): void {
    this.bpm = bpm;
    this.lastAt = receivedAt;
    if (this.state !== 'connected') {
      this.state = 'connected';
      this.onChange?.();
    }
    this.onSample?.(bpm, t);
  }

  override current(now: number = Date.now()): number | null {
    return this.bpm !== null && now - this.lastAt < WATCH_HR_STALE_MS ? this.bpm : null;
  }

  override async connect(): Promise<void> {
    throw new Error('The watch connects through the watch app, not from here');
  }

  /** The session calls this when a night ends; there is no Bluetooth link to close. */
  override disconnect(): void {
    this.state = 'idle';
    this.bpm = null;
    this.lastAt = 0;
  }
}

// ---------- Screen Wake Lock ----------

export type WakeLockState = 'pending' | 'held' | 'lost' | 'unavailable';

interface Sentinel extends EventTarget {
  release(): Promise<void>;
}

export class WakeLockHolder {
  state: WakeLockState = 'pending';
  /** On native Android the activity keeps the screen on itself; the WebView API is unreliable there. */
  constructor(private readonly native: () => boolean = isNativeAndroid) {}
  onChange: (() => void) | null = null;
  private sentinel: Sentinel | null = null;
  private active = false;
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible' && this.active) void this.acquire();
  };

  start(): void {
    this.active = true;
    if (this.native()) return;
    document.addEventListener('visibilitychange', this.onVisible);
    void this.acquire();
  }

  stop(): void {
    this.active = false;
    document.removeEventListener('visibilitychange', this.onVisible);
    void this.sentinel?.release().catch(() => undefined);
    this.sentinel = null;
  }

  private async acquire(): Promise<void> {
    const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<Sentinel> } }).wakeLock;
    if (!wl) return this.set('unavailable');
    try {
      const s = await wl.request('screen');
      // stop() may have run while the request was pending; the grant would otherwise outlive the night.
      if (!this.active) {
        void s.release().catch(() => undefined);
        return;
      }
      this.sentinel = s;
      s.addEventListener('release', () => {
        if (this.sentinel === s) this.sentinel = null;
        if (this.active) this.set('lost');
      });
      this.set('held');
    } catch {
      this.set(this.state === 'held' ? 'lost' : 'unavailable');
    }
  }

  private set(s: WakeLockState): void {
    this.state = s;
    try {
      this.onChange?.();
    } catch {
      /* ignore */
    }
  }
}
