// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { EPOCH_MS, WATCH_FRESH_MS, WATCH_GRACE_MS, WATCH_RECOVER_EPOCHS, WATCH_RECOVER_MS, WATCH_SHIFT_MS } from '../engine/config';
import { SourceSelector } from '../engine/sourceSelector';
import type { ActivitySample } from '../engine/types';
import { isNativeAndroid, SleepAidNative, type SleepAidNativePlugin, type WatchStatus } from './plugin';

/**
 * Wear OS watch as a heart-rate and motion source.
 *
 * Batch schema v1 (UTF-8 JSON from the watch app, see android/wear Protocol.kt; fixture:
 * tests/fixtures/watch-batch.json):
 *   { v: 1, session, seq, sentAt, epochMs: 30000,
 *     epochs: [{ t: epochStartMs, act: meanAbsDeviation m/s^2, n: samples }],
 *     hr: [[ms, bpm]] }
 */
export const WATCH_SCHEMA = 1;

// The timing constants (shift, staleness timeout, grace, recovery hysteresis) live with the engine
// (src/engine/config.ts) because the source selector is part of it; re-exported for existing importers.
export { WATCH_FRESH_MS, WATCH_GRACE_MS, WATCH_RECOVER_EPOCHS, WATCH_RECOVER_MS, WATCH_SHIFT_MS };

export interface WatchEpoch {
  /** Epoch start on the watch clock (not shifted). */
  start: number;
  activity: number;
  samples: number;
}
export interface WatchHr {
  t: number;
  bpm: number;
}
export interface WatchBatch {
  session: string;
  seq: number;
  sentAt: number;
  epochs: WatchEpoch[];
  hr: WatchHr[];
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Decodes one batch; null for anything that is not a valid v1 batch. Single bad entries are dropped, not the batch. */
export function decodeWatchBatch(json: string): WatchBatch | null {
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const b = o as Record<string, unknown>;
  if (b.v !== WATCH_SCHEMA || b.epochMs !== EPOCH_MS) return null;
  if (typeof b.session !== 'string' || b.session.length === 0 || b.session.length > 64) return null;
  if (!isNum(b.seq) || !Number.isInteger(b.seq) || b.seq < 1 || !isNum(b.sentAt)) return null;
  if (!Array.isArray(b.epochs) || !Array.isArray(b.hr)) return null;

  const epochs: WatchEpoch[] = [];
  for (const e of b.epochs as unknown[]) {
    const r = e as Record<string, unknown> | null;
    if (r && isNum(r.t) && isNum(r.act) && r.act >= 0 && isNum(r.n) && Number.isInteger(r.n) && r.n >= 1) {
      epochs.push({ start: r.t, activity: r.act, samples: r.n });
    }
  }
  const hr: WatchHr[] = [];
  for (const p of b.hr as unknown[]) {
    if (Array.isArray(p) && isNum(p[0]) && isNum(p[1]) && p[1] >= 20 && p[1] <= 250) hr.push({ t: p[0], bpm: p[1] });
  }
  epochs.sort((a, c) => a.start - c.start);
  hr.sort((a, c) => a.t - c.t);
  return { session: b.session, seq: b.seq, sentAt: b.sentAt, epochs, hr };
}

/** Remembers which (session, seq) were already taken. A new night has a new session, so its seq 1 is not a repeat. */
export class WatchDedup {
  private readonly seen = new Map<string, Set<number>>();
  constructor(private readonly maxSessions = 4) {}

  /** True the first time a batch is offered, false for repeats. */
  accept(b: Pick<WatchBatch, 'session' | 'seq'>): boolean {
    let seqs = this.seen.get(b.session);
    if (!seqs) {
      seqs = new Set();
      this.seen.set(b.session, seqs);
      if (this.seen.size > this.maxSessions) this.seen.delete(this.seen.keys().next().value as string);
    }
    if (seqs.has(b.seq)) return false;
    seqs.add(b.seq);
    return true;
  }
}

export interface FollowOptions {
  /** Batches (and samples) older than this are ignored: leftovers of an earlier night. */
  notBefore: number;
  /** Activity of one epoch, already shifted by WATCH_SHIFT_MS. Always called before the heart rate of the same batch. */
  onEpoch: (a: ActivitySample) => void;
  /** One heart-rate sample, time already shifted; `receivedAt` is the phone clock at arrival. */
  onHr: (bpm: number, t: number, receivedAt: number) => void;
  now?: () => number;
  /** Night start, for the watch grace period. Defaults to `notBefore`. */
  startedAt?: number;
  /** Source gating shared with the caller; one is created when absent. Wrist activity passes only while it says 'watch'. */
  selector?: SourceSelector;
}

export interface WatchFollower {
  /** Phone clock of the last batch whose activity was admitted (watch was the source); 0 before the first. */
  lastActivityAt(): number;
  /** Phone clock of the last batch of any kind; 0 before the first. */
  lastBatchAt(): number;
  stop(): void;
}

const DRAIN_EVERY_MS = 20_000;
const STATUS_TIMEOUT_MS = 4_000;

const PREF_KEY = 'sleepaid.useWatch';

/** Whether the user wants the watch used when one is connected. On by default. */
export const watchPreference = {
  get(): boolean {
    try {
      return localStorage.getItem(PREF_KEY) !== '0';
    } catch {
      return true;
    }
  },
  set(on: boolean): void {
    try {
      localStorage.setItem(PREF_KEY, on ? '1' : '0');
    } catch {
      /* not persisted */
    }
  },
};

const NO_WATCH: WatchStatus = { available: false, connected: false, nodes: [], lastEpochAt: 0, lastSeq: 0, session: '' };

/** Glue between the native watch link and the night. Everything is a no-op off Android. Injectable for tests. */
export function createWatchLink(plugin: SleepAidNativePlugin, isNative: () => boolean) {
  return {
    get enabled(): boolean {
      return isNative();
    },

    /** Never throws; reports "not connected" on any failure. */
    async status(): Promise<WatchStatus> {
      if (!isNative()) return NO_WATCH;
      try {
        // A Data Layer query that never answers must not hold up starting the night.
        return await Promise.race([plugin.getWatchStatus(), new Promise<WatchStatus>((resolve) => setTimeout(() => resolve(NO_WATCH), STATUS_TIMEOUT_MS))]);
      } catch {
        return NO_WATCH;
      }
    },

    /** Asks the watch to start recording; resolves with how many watches were messaged. Never throws. */
    async start(reset: boolean): Promise<number> {
      if (!isNative()) return 0;
      try {
        return (await plugin.startWatch({ reset })).sent;
      } catch {
        return 0;
      }
    },

    async stop(): Promise<void> {
      if (!isNative()) return;
      await plugin.stopWatch().catch(() => undefined);
    },

    /** Starts feeding watch data to the callbacks: live events, plus a drain at start, on resume and every 20 s. */
    follow(o: FollowOptions): WatchFollower {
      const now = o.now ?? Date.now;
      const dedup = new WatchDedup();
      const selector = o.selector ?? new SourceSelector({ startedAt: o.startedAt ?? o.notBefore, watchEnabled: true });
      let lastActivityAt = 0;
      let lastBatchAt = 0;
      let stopped = false;

      const take = (b: WatchBatch) => {
        if (stopped || !dedup.accept(b)) return;
        const at = now();
        lastBatchAt = at;
        const epochs = b.epochs.filter((e) => e.start >= o.notBefore);
        const hr = b.hr.filter((p) => p.t >= o.notBefore);
        selector.onWatchEpochs(at, epochs.map((e) => e.start));
        const admit = selector.source(at) === 'watch';
        if (admit && epochs.length) lastActivityAt = at;
        // Activity first: the stager closes an epoch as soon as it sees a later sample, so the epoch's activity
        // has to be in before any heart-rate sample that comes after it. Heart rate is never gated (no phone twin).
        if (admit) for (const e of epochs) o.onEpoch({ t: e.start + WATCH_SHIFT_MS, activity: e.activity, samples: e.samples });
        for (const p of hr) o.onHr(p.bpm, p.t + WATCH_SHIFT_MS, at);
      };
      const takeJson = (json: string) => {
        const b = decodeWatchBatch(json);
        if (b) take(b);
      };
      const drain = () => {
        plugin
          .drainWatchEpochs()
          .then((r) => {
            const batches = r.batches.map(decodeWatchBatch).filter((b): b is WatchBatch => b !== null);
            batches.sort((a, c) => a.sentAt - c.sentAt || a.seq - c.seq);
            for (const b of batches) take(b);
          })
          .catch(() => undefined);
      };

      let handle: { remove(): Promise<void> } | null = null;
      plugin
        .addListener('watchEpochs', (e) => takeJson(e.json))
        .then((h) => {
          if (stopped) void h.remove();
          else handle = h;
        })
        .catch(() => undefined);

      const onVisible = () => {
        if (document.visibilityState === 'visible') drain();
      };
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('pageshow', onVisible);
      const timer = setInterval(drain, DRAIN_EVERY_MS);
      drain();

      return {
        lastActivityAt: () => lastActivityAt,
        lastBatchAt: () => lastBatchAt,
        stop() {
          stopped = true;
          clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisible);
          window.removeEventListener('pageshow', onVisible);
          void handle?.remove().catch(() => undefined);
          handle = null;
        },
      };
    },
  };
}

export type WatchLink = ReturnType<typeof createWatchLink>;

export const watchLink: WatchLink = createWatchLink(SleepAidNative, isNativeAndroid);
