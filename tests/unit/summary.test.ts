// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { describe, expect, it } from 'vitest';
import { EPOCH_MS } from '../../src/engine/config';
import { qualityScore, summarizeNight } from '../../src/engine/summary';
import type { EpochResult, Stage } from '../../src/engine/types';

function build(parts: Array<[Stage, number]>): EpochResult[] {
  const out: EpochResult[] = [];
  for (const [stage, n] of parts) for (let i = 0; i < n; i++) out.push({ start: 1_000_000 + out.length * EPOCH_MS, stage, confidence: 0.8 });
  return out;
}

describe('summarizeNight', () => {
  const night = build([
    ['wake', 24],
    ['light', 40],
    ['deep', 40],
    ['light', 20],
    ['rem', 30],
    ['wake', 2],
    ['light', 20],
    ['rem', 24],
    ['unknown', 4],
    ['light', 10],
  ]);
  const s = summarizeNight(night);

  it('computes durations, latency and efficiency', () => {
    expect(s.minutesPerStage).toEqual({ wake: 13, light: 45, deep: 20, rem: 27, unknown: 2 });
    expect(s.totalSleepMin).toBe(92);
    expect(s.sleepOnsetLatencyMin).toBe(12);
    // Gaps are excluded from the denominator: 92 / (92 + 13).
    expect(s.efficiency).toBeCloseTo((100 * 92) / 105, 10);
  });

  it('counts awakenings only after sleep onset and ignores sub-minute flicker', () => {
    expect(s.awakenings).toBe(1);
    const flicker = summarizeNight(build([['light', 30], ['wake', 1], ['light', 30]]));
    expect(flicker.awakenings).toBe(0);
  });

  it('measures cycle length between REM periods', () => {
    // Two REM periods close cycles of 65 and 23 min measured from sleep onset; mean 44.
    expect(s.meanCycleMin).toBe(44);
  });

  it('scores quality with the documented formula', () => {
    expect(s.quality).toBe(64);
    expect(qualityScore({ totalSleepMin: 450, efficiency: 95, restorativeShare: 0.4, latencyMin: 10, awakenings: 0 })).toBe(100);
    expect(qualityScore({ totalSleepMin: 0, efficiency: 0, restorativeShare: 0, latencyMin: null, awakenings: 6 })).toBe(0);
  });

  it('exposes the hypnogram and handles empty or never-asleep input', () => {
    expect(s.hypnogram).toHaveLength(night.length);
    const empty = summarizeNight([]);
    expect(empty.totalSleepMin).toBe(0);
    expect(empty.sleepOnsetLatencyMin).toBeNull();
    expect(summarizeNight(build([['wake', 10]])).sleepOnsetLatencyMin).toBeNull();
  });
});
