// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { describe, expect, it } from 'vitest';
import { EPOCH_MS } from '../../src/engine/config';
import { Stager } from '../../src/engine/stager';
import type { Epoch, Stage } from '../../src/engine/types';
import { stageNight } from '../../src/sim/replay';
import { generateNight } from '../../src/sim/syntheticNight';

const NIGHTS = 20;
const STAGES: Stage[] = ['wake', 'light', 'deep', 'rem'];

function confusion(hr: boolean) {
  const m: Record<string, Record<string, number>> = {};
  for (const t of STAGES) m[t] = { wake: 0, light: 0, deep: 0, rem: 0, unknown: 0 };
  for (let seed = 1; seed <= NIGHTS; seed++) {
    const night = generateNight({ seed, bedtime: 0, durationMin: 450, motionHz: 2, hr });
    stageNight(night).forEach((r, i) => {
      m[night.truth[i]!]![r.stage]!++;
    });
  }
  return m;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const col = (m: ReturnType<typeof confusion>, s: Stage) => sum(STAGES.map((t) => m[t]![s]!));
const row = (m: ReturnType<typeof confusion>, s: Stage) => sum(Object.values(m[s]!));

describe('Stager accuracy on synthetic nights (with HR)', () => {
  const m = confusion(true);
  const recall = (s: Stage) => m[s]![s]! / row(m, s);
  const precision = (s: Stage) => m[s]![s]! / col(m, s);

  it('reports per-stage agreement', () => {
    const rows = STAGES.map((s) => ({ truth: s, recall: +recall(s).toFixed(3), precision: +precision(s).toFixed(3) }));
    console.info('stager agreement vs truth (' + NIGHTS + ' nights, HR on)\n' + JSON.stringify(rows));
    expect(rows).toHaveLength(4);
  });

  // Thresholds sit ~10 points below the values measured on the committed seeds (deep precision 0.82,
  // deep recall 0.89, light recall 0.95, wake recall 0.99), leaving room for retuning without flakiness.
  it('deep detection is precise', () => {
    expect(precision('deep')).toBeGreaterThanOrEqual(0.7);
    expect(recall('deep')).toBeGreaterThanOrEqual(0.75);
  });

  it('light and wake are recalled', () => {
    expect(recall('light')).toBeGreaterThanOrEqual(0.88);
    expect(recall('wake')).toBeGreaterThanOrEqual(0.88);
  });

  it('REM is distinguishable with HR', () => {
    expect(precision('rem')).toBeGreaterThanOrEqual(0.8);
    expect(recall('rem')).toBeGreaterThanOrEqual(0.8);
  });
});

describe('Stager without HR', () => {
  it('still separates wake from sleep, and never emits REM', () => {
    const m = confusion(false);
    expect(m.wake!.wake! / row(m, 'wake')).toBeGreaterThanOrEqual(0.88);
    expect(col(m, 'rem')).toBe(0);
    expect(m.light!.light! / row(m, 'light')).toBeGreaterThanOrEqual(0.5);
  });

  it('marks still-but-not-yet-deep epochs as low-confidence light', () => {
    const s = new Stager();
    const e = (i: number): Epoch => ({ start: i * EPOCH_MS, activity: 0.002, hrMean: null, hrSd: null, motionSamples: 60, hrSamples: 0 });
    const r = Array.from({ length: 8 }, (_, i) => s.process(e(i)));
    expect(r[2]!.stage).toBe('light');
    expect(r[2]!.confidence).toBeLessThan(0.5);
    expect(r[7]!.stage).toBe('deep');
    expect(r[7]!.confidence).toBeLessThan(0.5);
  });
});

describe('Stager edge cases', () => {
  it("labels sensor-gap epochs 'unknown'", () => {
    const s = new Stager();
    const r = s.process({ start: 0, activity: NaN, hrMean: null, hrSd: null, motionSamples: 0, hrSamples: 0 });
    expect(r).toEqual({ start: 0, stage: 'unknown', confidence: 0 });
  });

  it('is causal: appending future samples never changes earlier results', () => {
    const night = generateNight({ seed: 7, bedtime: 0, durationMin: 240, motionHz: 2 });
    const full = stageNight(night);
    const cut = Math.floor(full.length * 0.6);
    const cutMs = night.startMs + cut * EPOCH_MS;
    const truncated = {
      ...night,
      truth: night.truth.slice(0, cut),
      motion: night.motion.filter((s) => s.t < cutMs),
      hr: night.hr.filter((s) => s.t < cutMs),
    };
    const partial = stageNight(truncated);
    expect(partial.length).toBe(cut);
    expect(partial).toEqual(full.slice(0, cut));
  });
});
