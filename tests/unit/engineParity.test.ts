// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as cfg from '../../src/engine/config';
import { EPOCH_MS } from '../../src/engine/config';
import { EpochAggregator } from '../../src/engine/epochs';
import { Pipeline } from '../../src/engine/pipeline';
import type { AlarmDecision } from '../../src/engine/smartAlarm';
import { SourceSelector } from '../../src/engine/sourceSelector';
import { Stager } from '../../src/engine/stager';
import { applyWatchBatch } from '../../src/engine/watchFeed';
import type { Epoch, EpochResult } from '../../src/engine/types';
import { generateNight, type SyntheticNight } from '../../src/sim/syntheticNight';

/**
 * Shared synthetic nights for the Kotlin engine (android/app/src/test, ParityTest). The JavaScript engine is the
 * reference: this file runs it over a few seeded synthetic nights and compares the result with the committed
 * JSON in tests/fixtures/engine-parity. The Kotlin suite reads the same files and must produce the same stages
 * and the same wake decision, so neither engine can drift without a test failing.
 *
 * Regenerate after an intended engine change:  npm run fixtures:engine
 * Synthetic data only; nothing here comes from a person.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'engine-parity');
const UPDATE = process.env.UPDATE_PARITY_FIXTURES === '1';
const MIN = 60_000;
const TICK_MS = 5_000;
/** Inputs are rounded before the reference run, so JS and Kotlin consume the identical numbers. */
const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

/** phone: no watch. watch: watch only. mixed: phone sensor all night plus a watch that goes silent for a while. */
type Source = 'phone' | 'watch' | 'mixed';

interface CaseDef {
  name: string;
  description: string;
  seed: number;
  source: Source;
  hr: boolean;
  durationMin: number;
  windowStartMin: number;
  windowEndMin: number;
  dropoutFromMin?: number;
  /** mixed only: the watch delivers nothing from this minute to that one. */
  watchGapMin?: [number, number];
  expectReason: 'smart' | 'fallback';
}

const CASES: CaseDef[] = [
  { name: 'phone-hr-smart', description: 'Phone motion plus heart rate; the window opens late in the night and a smart wake is expected.', seed: 21, source: 'phone', hr: true, durationMin: 150, windowStartMin: 100, windowEndMin: 130, expectReason: 'smart' },
  { name: 'phone-motion-only-smart', description: 'Phone motion without heart rate (HR-less stager rules).', seed: 5, source: 'phone', hr: false, durationMin: 150, windowStartMin: 100, windowEndMin: 130, expectReason: 'smart' },
  { name: 'phone-dropout-fallback', description: 'Both sensors go silent mid-night; only the window-end fallback can fire.', seed: 3, source: 'phone', hr: true, durationMin: 150, windowStartMin: 100, windowEndMin: 130, dropoutFromMin: 60, expectReason: 'fallback' },
  { name: 'watch-hr-smart', description: 'Watch epochs (activity plus heart rate) delivered in batches with the 60 s shift.', seed: 21, source: 'watch', hr: true, durationMin: 150, windowStartMin: 100, windowEndMin: 130, expectReason: 'smart' },
  { name: 'watch-stale-phone-watch', description: 'Watch first: the watch is silent from minute 40 to 70, the phone sensor covers the gap after the staleness timeout, and the watch takes over again after the recovery hysteresis. Phone motion is recorded all night but only used while the watch is stale.', seed: 21, source: 'mixed', hr: true, durationMin: 150, windowStartMin: 100, windowEndMin: 130, watchGapMin: [40, 70], expectReason: 'smart' },
];

interface WatchBatchFx {
  /** Phone clock at which the batch arrives. */
  arrival: number;
  epochs: Array<[number, number, number]>;
  hr: Array<[number, number]>;
}

interface Fixture {
  name: string;
  description: string;
  startMs: number;
  windowStart: number;
  windowEnd: number;
  tickMs: number;
  source: Source;
  /** Whether the night asked for the watch (sets up the source selector). */
  useWatch: boolean;
  /** Flat [t - startMs, ax, ay, az, ...]. */
  motion: number[];
  /** Flat [t - startMs, bpm, ...]. */
  hr: number[];
  watchBatches: WatchBatchFx[];
  expected: {
    epochs: Array<{ start: number; stage: string; confidence: number; activity: number | null; hrMean: number | null; source: string | null }>;
    decision: { reason: string; at: number; stage: string };
  };
}

/** The same loop as src/sim/replay.ts, extended with watch batches, so the fixture records what production does. */
function runReference(f: Pick<Fixture, 'startMs' | 'windowStart' | 'windowEnd' | 'tickMs' | 'motion' | 'hr' | 'watchBatches' | 'useWatch'>) {
  let now = f.startMs;
  const stager = new Stager();
  const inputs: Epoch[] = [];
  const pipe = new Pipeline({
    windowStart: f.windowStart,
    windowEnd: f.windowEnd,
    clock: () => now,
    stager: {
      process(e) {
        inputs.push(e);
        return stager.process(e);
      },
    },
  });
  const selector = new SourceSelector({ startedAt: f.startMs, watchEnabled: f.useWatch });
  let mi = 0;
  let hi = 0;
  let bi = 0;
  let decision: AlarmDecision | null = null;
  for (let t = f.startMs; !decision; t = Math.min(t + f.tickMs, f.windowEnd)) {
    now = t;
    for (;;) {
      const mT = mi < f.motion.length ? f.startMs + (f.motion[mi] as number) : Infinity;
      const hT = hi < f.hr.length ? f.startMs + (f.hr[hi] as number) : Infinity;
      const mOk = mT <= t;
      const hOk = hT <= t;
      if (!mOk && !hOk) break;
      if (mOk && (!hOk || mT <= hT)) {
        // Phone motion is consumed either way but only used while the phone is the motion source.
        if (selector.source(t) === 'phone') pipe.ingestMotion({ t: mT, ax: f.motion[mi + 1] as number, ay: f.motion[mi + 2] as number, az: f.motion[mi + 3] as number });
        mi += 4;
      } else {
        pipe.ingestHr({ t: hT, bpm: f.hr[hi + 1] as number });
        hi += 2;
      }
    }
    // Watch batches through the shared feed: source selection, shift, activity before heart rate.
    while (bi < f.watchBatches.length && (f.watchBatches[bi] as WatchBatchFx).arrival <= t) {
      const b = f.watchBatches[bi++] as WatchBatchFx;
      applyWatchBatch(
        pipe,
        selector,
        { epochs: b.epochs.map(([start, activity, samples]) => ({ start, activity, samples })), hr: b.hr.map(([ht, bpm]) => ({ t: ht, bpm })) },
        t,
        -Infinity,
      );
    }
    decision = pipe.tick(t);
    if (t >= f.windowEnd) break;
  }
  return { decision: decision as AlarmDecision, results: pipe.results, inputs };
}

function build(def: CaseDef): Fixture {
  const night: SyntheticNight = generateNight({
    seed: def.seed,
    bedtime: 1_800_000_000_000,
    durationMin: def.durationMin,
    hr: def.hr,
    motion: true,
    motionHz: 1,
    dropouts: def.dropoutFromMin === undefined ? [] : [{ fromMs: 1_800_000_000_000 + def.dropoutFromMin * MIN, toMs: 1_800_000_000_000 + 10_000 * MIN }],
  });
  const startMs = night.startMs;
  const motion: number[] = [];
  for (const m of night.motion) {
    expect(Number.isInteger(m.t)).toBe(true);
    motion.push(m.t - startMs, round5(m.ax), round5(m.ay), round5(m.az));
  }
  // Every second sample is enough heart rate and halves the file.
  const hr: number[] = [];
  night.hr.forEach((h, i) => {
    if (i % 2 === 0) hr.push(h.t - startMs, h.bpm);
  });

  const base = {
    startMs,
    windowStart: startMs + def.windowStartMin * MIN,
    windowEnd: startMs + def.windowEndMin * MIN,
    tickMs: TICK_MS,
  };

  let watchBatches: WatchBatchFx[] = [];
  let phoneMotion = motion;
  let phoneHr = hr;
  const watchGap = def.watchGapMin ? ([startMs + def.watchGapMin[0] * MIN, startMs + def.watchGapMin[1] * MIN] as const) : null;
  if (def.source !== 'phone') {
    // What the watch would send: activity per epoch computed like the phone aggregator, heart rate per epoch.
    const agg = new EpochAggregator();
    const closed: Epoch[] = [];
    for (let i = 0; i < motion.length; i += 4) {
      closed.push(...agg.ingestMotion({ t: startMs + (motion[i] as number), ax: motion[i + 1] as number, ay: motion[i + 2] as number, az: motion[i + 3] as number }));
    }
    closed.push(...agg.advance(startMs + (def.durationMin + 2) * MIN));
    watchBatches = closed
      .filter((e) => Number.isFinite(e.activity))
      .filter((e) => !watchGap || e.start < watchGap[0] || e.start >= watchGap[1])
      .map((e) => ({
        // The watch closes an epoch with its next sensor event, sends, Bluetooth adds a moment.
        arrival: e.start + EPOCH_MS + 15_000,
        epochs: [[e.start, e.activity, e.motionSamples]] as Array<[number, number, number]>,
        hr: [] as Array<[number, number]>,
      }));
    for (let i = 0; i < hr.length; i += 2) {
      const t = startMs + (hr[i] as number);
      const b = watchBatches.find((x) => x.epochs[0]?.[0] === Math.floor(t / EPOCH_MS) * EPOCH_MS);
      b?.hr.push([t, hr[i + 1] as number]);
    }
    // 'watch': nothing from the phone. 'mixed': the phone sensor runs all night, the selector decides when it counts.
    if (def.source === 'watch') phoneMotion = [];
    phoneHr = [];
  }

  const input = { ...base, useWatch: def.source !== 'phone', motion: phoneMotion, hr: phoneHr, watchBatches };
  const ref = runReference(input);
  expect(ref.results.length).toBe(ref.inputs.length);
  return {
    name: def.name,
    description: def.description + ' Synthetic, seeded; inputs rounded to 5 decimals.',
    ...base,
    source: def.source,
    useWatch: def.source !== 'phone',
    motion: phoneMotion,
    hr: phoneHr,
    watchBatches,
    expected: {
      epochs: ref.results.map((r: EpochResult, i) => {
        const e = ref.inputs[i] as Epoch;
        return {
          start: r.start,
          stage: r.stage,
          confidence: r.confidence,
          activity: Number.isFinite(e.activity) ? e.activity : null,
          hrMean: e.hrMean,
          source: e.source ?? null,
        };
      }),
      decision: { reason: ref.decision.reason, at: ref.decision.at, stage: ref.decision.stageAtTrigger },
    },
  };
}

describe('engine parity fixtures (shared with the Kotlin engine)', () => {
  for (const def of CASES) {
    it(`${def.name}: committed fixture equals what the JS engine produces now`, () => {
      const fx = build(def);
      const path = join(DIR, def.name + '.json');
      // The case is only a useful parity check if it exercises the intended branch.
      expect(fx.expected.decision.reason).toBe(def.expectReason);
      expect(fx.expected.epochs.length).toBeGreaterThan(60);
      // Never a repeated or skipped epoch, whatever the sources did.
      fx.expected.epochs.forEach((e, i) => {
        if (i > 0) expect(e.start - (fx.expected.epochs[i - 1] as { start: number }).start).toBe(EPOCH_MS);
      });
      if (def.source === 'mixed') {
        // watch, gap epochs (unknown) until the staleness timeout, phone, then the watch again (its data is shifted ahead of the phone's).
        const seq = fx.expected.epochs.map((e) => e.source ?? 'none').filter((v, i, a) => i === 0 || v !== a[i - 1]);
        expect(seq).toEqual(['watch', 'none', 'phone', 'watch']);
      }
      if (UPDATE) {
        mkdirSync(DIR, { recursive: true });
        writeFileSync(path, JSON.stringify(fx) + '\n');
        return;
      }
      const committed = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
      // Compare through JSON so -0, NaN and number formatting behave exactly as in the file.
      expect(JSON.parse(JSON.stringify(fx))).toEqual(committed);
    });
  }
});

/** The constants the Kotlin engine mirrors (EngineConfig.kt); the Kotlin ConfigParityTest compares against this file. */
function configFixture() {
  const c = cfg as unknown as Record<string, number | readonly number[]>;
  const names = [
    'EPOCH_MS', 'REORDER_GRACE_MS', 'GRAVITY_TAU_MS', 'MAX_GAP_EPOCHS', 'MIN_HR_SAMPLES_FOR_SD', 'CK_WEIGHTS', 'WAKE_THRESHOLD',
    'STILL_ACTIVITY', 'DEEP_STILL_EPOCHS', 'BASELINE_MIN_HR_EPOCHS', 'DEEP_HR_MARGIN_BPM', 'DEEP_SD_RATIO', 'REM_SD_RATIO',
    'REM_STILL_EPOCHS', 'WAKE_THRESHOLD_WATCH', 'STILL_ACTIVITY_WATCH', 'WATCH_SHIFT_MS', 'WATCH_FRESH_MS', 'WATCH_GRACE_MS',
    'WATCH_RECOVER_EPOCHS', 'WATCH_RECOVER_MS', 'MIN_WINDOW_MS', 'MAX_WINDOW_MS', 'LIGHT_RUN_EPOCHS', 'DEEP_COOLDOWN_EPOCHS', 'FRESH_EPOCHS', 'SMART_MIN_CONFIDENCE',
  ];
  const out: Record<string, number | readonly number[]> = {};
  for (const n of names) out[n] = c[n] as number | readonly number[];
  return out;
}

describe('engine constants shared with the Kotlin engine', () => {
  it('config.json is current', () => {
    const path = join(DIR, 'config.json');
    const fx = configFixture();
    expect(Object.values(fx).every((v) => v !== undefined)).toBe(true);
    if (UPDATE) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(path, JSON.stringify(fx, null, 1) + '\n');
      return;
    }
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(fx)));
  });
});
