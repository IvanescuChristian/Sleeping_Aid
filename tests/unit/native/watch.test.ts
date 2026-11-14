// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatchHeartRate } from '../../../src/app/sensors';
import { EPOCH_MS } from '../../../src/engine/config';
import { EpochAggregator } from '../../../src/engine/epochs';
import { Pipeline } from '../../../src/engine/pipeline';
import type { ActivitySample } from '../../../src/engine/types';
import type { SleepAidNativePlugin } from '../../../src/native/plugin';
import {
  WATCH_SHIFT_MS,
  WatchDedup,
  chooseMotionSource,
  createWatchLink,
  decodeWatchBatch,
  type WatchBatch,
} from '../../../src/native/watch';
import { stageNight } from '../../../src/sim/replay';
import { generateNight } from '../../../src/sim/syntheticNight';

interface Fixture {
  wire: string;
  expected: WatchBatch;
  invalid: string[];
}
const fixture = JSON.parse(readFileSync(new URL('../../fixtures/watch-batch.json', import.meta.url), 'utf8')) as Fixture;

describe('decodeWatchBatch (contract with the watch app)', () => {
  it('decodes the shared fixture exactly', () => {
    expect(decodeWatchBatch(fixture.wire)).toEqual(fixture.expected);
  });

  it('rejects every invalid fixture', () => {
    for (const bad of fixture.invalid) expect(decodeWatchBatch(bad), bad).toBeNull();
  });

  it('drops single bad entries but keeps the batch', () => {
    const o = JSON.parse(fixture.wire) as Record<string, unknown>;
    o.epochs = [{ t: 1, act: -1, n: 5 }, { t: 2, act: 0.1, n: 0 }, { t: 3, act: 0.1, n: 5 }, null, 'x'];
    o.hr = [[1, 10], [2, 300], [3, 60], [4], 'x', [5, 'a']];
    const b = decodeWatchBatch(JSON.stringify(o));
    expect(b?.epochs).toEqual([{ start: 3, activity: 0.1, samples: 5 }]);
    expect(b?.hr).toEqual([{ t: 3, bpm: 60 }]);
  });

  it('sorts epochs and heart rate by time', () => {
    const o = JSON.parse(fixture.wire) as Record<string, unknown>;
    o.epochs = [{ t: 60_000, act: 0.1, n: 5 }, { t: 30_000, act: 0.2, n: 5 }];
    o.hr = [[2, 60], [1, 61]];
    const b = decodeWatchBatch(JSON.stringify(o));
    expect(b?.epochs.map((e) => e.start)).toEqual([30_000, 60_000]);
    expect(b?.hr.map((p) => p.t)).toEqual([1, 2]);
  });
});

describe('WatchDedup', () => {
  it('drops repeats of (session, seq) but not the next night, whose seq starts at 1 again', () => {
    const d = new WatchDedup();
    expect(d.accept({ session: 'a', seq: 1 })).toBe(true);
    expect(d.accept({ session: 'a', seq: 1 })).toBe(false);
    expect(d.accept({ session: 'a', seq: 2 })).toBe(true);
    expect(d.accept({ session: 'b', seq: 1 })).toBe(true);
    expect(d.accept({ session: 'b', seq: 1 })).toBe(false);
  });

  it('keeps a bounded number of sessions', () => {
    const d = new WatchDedup(2);
    d.accept({ session: 'a', seq: 1 });
    d.accept({ session: 'b', seq: 1 });
    d.accept({ session: 'c', seq: 1 });
    expect(d.accept({ session: 'a', seq: 1 })).toBe(true); // forgotten, harmless: the stager drops old epochs
  });
});

describe('chooseMotionSource', () => {
  const startedAt = 1_000_000;
  it('waits for the watch during the grace period, then falls back to the phone', () => {
    expect(chooseMotionSource({ now: startedAt + 100_000, startedAt, lastActivityAt: 0 })).toBe('watch');
    expect(chooseMotionSource({ now: startedAt + 300_000, startedAt, lastActivityAt: 0 })).toBe('phone');
  });
  it('uses the watch while fresh and returns to it when it recovers', () => {
    expect(chooseMotionSource({ now: startedAt + 500_000, startedAt, lastActivityAt: startedAt + 450_000 })).toBe('watch');
    expect(chooseMotionSource({ now: startedAt + 700_000, startedAt, lastActivityAt: startedAt + 450_000 })).toBe('phone');
    expect(chooseMotionSource({ now: startedAt + 710_000, startedAt, lastActivityAt: startedAt + 705_000 })).toBe('watch');
  });
});

describe('EpochAggregator.ingestActivity', () => {
  const T0 = 1_800_000_000_000 - (1_800_000_000_000 % EPOCH_MS);
  it('turns pre-aggregated activity into the epoch value', () => {
    const a = new EpochAggregator();
    a.ingestActivity({ t: T0 + 5000, activity: 0.02, samples: 100 });
    a.ingestActivity({ t: T0 + 20_000, activity: 0.04, samples: 100 });
    const closed = a.advance(T0 + EPOCH_MS + 5000);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.activity).toBeCloseTo(0.03, 10);
    expect(closed[0]?.motionSamples).toBe(200);
  });

  it('rejects malformed values and counts late ones', () => {
    const a = new EpochAggregator();
    for (const bad of [
      { t: NaN, activity: 0.1, samples: 5 },
      { t: T0, activity: -0.1, samples: 5 },
      { t: T0, activity: 0.1, samples: 0 },
      { t: T0, activity: 0.1, samples: 1.5 },
    ] satisfies ActivitySample[]) {
      expect(a.ingestActivity(bad)).toEqual([]);
    }
    expect(a.rejected).toBe(4);
    a.ingestActivity({ t: T0, activity: 0.1, samples: 5 });
    a.advance(T0 + 10 * EPOCH_MS);
    a.ingestActivity({ t: T0, activity: 0.1, samples: 5 });
    expect(a.late).toBe(1);
  });
});

describe('watch to stager, end to end with delivery delay', () => {
  const T0 = 1_800_000_000_000 - (1_800_000_000_000 % EPOCH_MS);
  const night = generateNight({ seed: 11, bedtime: T0, durationMin: 90, hr: true, motion: true, motionHz: 2 });
  const reference = stageNight(night);

  /** What the watch computes: per-epoch activity from the motion samples, heart rate of the same epoch. */
  function watchBatches(deliveryDelayMs: number): Array<{ at: number; json: string }> {
    const agg = new EpochAggregator();
    const epochs = night.motion.flatMap((m) => agg.ingestMotion(m));
    epochs.push(...agg.advance(night.startMs + night.truth.length * EPOCH_MS + 60_000));
    return epochs
      .filter((e) => Number.isFinite(e.activity))
      .map((e, i) => ({
        at: e.start + EPOCH_MS + deliveryDelayMs,
        json: JSON.stringify({
          v: 1,
          session: 'sim',
          seq: i + 1,
          sentAt: e.start + EPOCH_MS + deliveryDelayMs,
          epochMs: EPOCH_MS,
          epochs: [{ t: e.start, act: e.activity, n: e.motionSamples }],
          hr: night.hr.filter((h) => h.t >= e.start && h.t < e.start + EPOCH_MS).map((h) => [h.t, h.bpm]),
        }),
      }));
  }

  beforeEach(() => {
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('window', new EventTarget());
  });
  afterEach(() => vi.unstubAllGlobals());

  function run(deliveryDelayMs: number, shifted: boolean, duplicates = false) {
    let now = night.startMs;
    const pipe = new Pipeline({ windowStart: night.startMs + 1e9, windowEnd: night.startMs + 1e9 + 3_600_000, clock: () => now });
    const hr = new WatchHeartRate();
    hr.onSample = (bpm, t) => pipe.ingestHr({ t, bpm });
    let listener: ((e: { json: string }) => void) | null = null;
    const plugin = {
      addListener: (_: string, cb: (e: { json: string }) => void) => {
        listener = cb;
        return Promise.resolve({ remove: () => Promise.resolve() });
      },
      drainWatchEpochs: () => Promise.resolve({ batches: [] as string[] }),
    } as unknown as SleepAidNativePlugin;
    const link = createWatchLink(plugin, () => true);
    const feed = link.follow({
      notBefore: night.startMs - 60_000,
      now: () => now,
      onEpoch: (a) => pipe.ingestActivity(shifted ? a : { ...a, t: a.t - WATCH_SHIFT_MS }),
      onHr: (bpm, t, at) => hr.push(bpm, shifted ? t : t - WATCH_SHIFT_MS, at),
    });
    const pending = watchBatches(deliveryDelayMs);
    let next = 0;
    const end = night.startMs + night.truth.length * EPOCH_MS + 4 * 60_000;
    return Promise.resolve().then(() => {
      for (now = night.startMs; now <= end; now += 1000) {
        while (next < pending.length && (pending[next] as { at: number }).at <= now) {
          const json = (pending[next] as { json: string }).json;
          listener?.({ json });
          if (duplicates) listener?.({ json });
          next++;
        }
        pipe.tick(now);
      }
      feed.stop();
      return { pipe, hr };
    });
  }

  it('stages the watch epochs like the phone path, shifted by the fixed lag, with no late drops', async () => {
    const { pipe } = await run(45_000, true);
    expect(pipe.aggregator.late).toBe(0);
    expect(pipe.aggregator.rejected).toBe(0);
    expect(pipe.pipelineErrors).toBe(0);
    const got = pipe.results;
    expect(got.length).toBeGreaterThan(reference.length - 4);
    let compared = 0;
    for (const r of got) {
      const ref = reference.find((x) => x.start === r.start - WATCH_SHIFT_MS);
      if (!ref) continue;
      compared++;
      expect(r.stage, `epoch ${new Date(r.start).toISOString()}`).toBe(ref.stage);
    }
    expect(compared).toBeGreaterThan(reference.length - 6);
    // Both streams really reached the stager: not all unknown, and sleep stages that need heart rate appear.
    const known = (rs: Array<{ stage: string }>) => rs.filter((r) => r.stage !== 'unknown').length;
    expect(known(got)).toBeGreaterThanOrEqual(known(reference) - 2);
    expect(known(got)).toBeGreaterThan(80);
    expect(new Set(got.map((r) => r.stage)).size).toBeGreaterThanOrEqual(3);
  });

  it('is unaffected by batches delivered twice', async () => {
    const once = await run(45_000, true);
    const twice = await run(45_000, true, true);
    expect(twice.pipe.results).toEqual(once.pipe.results);
  });

  it('shows why the shift exists: unshifted watch data arrives in closed epochs and is dropped', async () => {
    const { pipe } = await run(45_000, false);
    expect(pipe.aggregator.late).toBeGreaterThan(10);
  });
});

describe('follow()', () => {
  beforeEach(() => {
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('window', new EventTarget());
  });
  afterEach(() => vi.unstubAllGlobals());

  function setup(drained: string[] = []) {
    let live: ((e: { json: string }) => void) | null = null;
    const removed = vi.fn(() => Promise.resolve());
    const plugin = {
      addListener: (_: string, cb: (e: { json: string }) => void) => {
        live = cb;
        return Promise.resolve({ remove: removed });
      },
      drainWatchEpochs: vi.fn(() => Promise.resolve({ batches: drained })),
    } as unknown as SleepAidNativePlugin;
    const calls: string[] = [];
    const feed = createWatchLink(plugin, () => true).follow({
      notBefore: 1_800_000_000_000,
      now: () => 42,
      onEpoch: (a) => calls.push(`epoch:${a.t}`),
      onHr: (bpm, t, at) => calls.push(`hr:${t}:${bpm}:${at}`),
    });
    return { feed, calls, removed, emit: (json: string) => live?.({ json }), plugin };
  }

  it('applies the shift, delivers activity before heart rate and tracks arrival times', async () => {
    const { feed, calls, emit } = setup();
    await Promise.resolve();
    expect(feed.lastActivityAt()).toBe(0);
    emit(fixture.wire);
    expect(calls).toEqual([
      `epoch:${1_800_000_060_000 + WATCH_SHIFT_MS}`,
      `epoch:${1_800_000_090_000 + WATCH_SHIFT_MS}`,
      `hr:${1_800_000_061_000 + WATCH_SHIFT_MS}:58:42`,
      `hr:${1_800_000_066_000 + WATCH_SHIFT_MS}:57.5:42`,
      `hr:${1_800_000_071_000 + WATCH_SHIFT_MS}:57.5:42`,
    ]);
    expect(feed.lastActivityAt()).toBe(42);
    expect(feed.lastBatchAt()).toBe(42);
    emit(fixture.wire); // repeat
    expect(calls).toHaveLength(5);
    feed.stop();
  });

  it('ignores data older than the night and malformed events', async () => {
    const { feed, calls, emit } = setup();
    await Promise.resolve();
    const o = JSON.parse(fixture.wire) as { epochs: Array<{ t: number }>; hr: number[][] };
    o.epochs[0]!.t = 1_700_000_000_000;
    o.hr[0]![0] = 1_700_000_000_000;
    emit(JSON.stringify({ ...o, seq: 9 }));
    expect(calls).toHaveLength(3); // second epoch and two heart-rate samples remain
    emit('garbage');
    expect(calls).toHaveLength(3);
    feed.stop();
  });

  it('takes buffered batches on start, in sent order, and de-duplicates against live events', async () => {
    const b = (seq: number, sentAt: number, t: number) =>
      JSON.stringify({ v: 1, session: 's', seq, sentAt, epochMs: 30000, epochs: [{ t, act: 0.1, n: 5 }], hr: [] });
    const t0 = 1_800_000_000_000;
    const { feed, calls, emit } = setup([b(2, 20, t0 + 30_000), b(1, 10, t0)]);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([`epoch:${t0 + WATCH_SHIFT_MS}`, `epoch:${t0 + 30_000 + WATCH_SHIFT_MS}`]);
    emit(b(2, 20, t0 + 30_000));
    expect(calls).toHaveLength(2);
    feed.stop();
  });

  it('stop() removes the native listener', async () => {
    const { feed, removed } = setup();
    await Promise.resolve();
    feed.stop();
    expect(removed).toHaveBeenCalled();
  });
});

describe('WatchHeartRate', () => {
  it('feeds the session like a Bluetooth monitor and goes stale after a gap', () => {
    const hr = new WatchHeartRate();
    const seen: Array<[number, number]> = [];
    hr.onSample = (bpm, t) => seen.push([bpm, t]);
    expect(hr.current(1000)).toBeNull();
    hr.push(61.5, 5000, 1000);
    expect(seen).toEqual([[61.5, 5000]]);
    expect(hr.state).toBe('connected');
    expect(hr.current(60_000)).toBe(61.5);
    expect(hr.current(1000 + 150_001)).toBeNull();
    hr.disconnect();
    expect(hr.state).toBe('idle');
    expect(hr.current(2000)).toBeNull();
  });
});
