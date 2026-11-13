// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { describe, expect, it } from 'vitest';
import type { NightSummary } from '../../src/engine/summary';
import { personalCycleMin, suggestBedtimes, suggestWakeWindow } from '../../src/engine/suggest';

const MIN = 60_000;
const wake = Date.UTC(2026, 0, 2, 7, 0);
const hist = (cycle: number | null, latency: number | null) => ({ meanCycleMin: cycle, sleepOnsetLatencyMin: latency }) as NightSummary;

describe('suggestBedtimes', () => {
  it('uses 90 min cycles and 15 min latency by default', () => {
    const [five, six] = suggestBedtimes(wake);
    expect(five).toEqual({ cycles: 5, bedtime: wake - 465 * MIN, sleepMin: 450 });
    expect(six).toEqual({ cycles: 6, bedtime: wake - 555 * MIN, sleepMin: 540 });
  });

  it('personalises to mean cycle and median latency from history', () => {
    const h = [hist(100, 10), hist(110, 20), hist(null, 40)];
    const [five] = suggestBedtimes(wake, h);
    expect(five?.bedtime).toBe(wake - (5 * 105 + 20) * MIN);
  });

  it('clamps absurd personal cycle lengths to 70-120 min', () => {
    expect(personalCycleMin([hist(200, null)])).toBe(120);
    expect(personalCycleMin([hist(30, null)])).toBe(70);
    expect(personalCycleMin([])).toBe(90);
  });
});

describe('suggestWakeWindow', () => {
  const bed = Date.UTC(2026, 0, 1, 23, 0);

  it('centres on the cycle boundary nearest the window end', () => {
    // Boundaries (bed + 15 min latency + n * 90): ... 05:15, 06:45, 08:15.
    const w = suggestWakeWindow(wake, { bedtime: bed });
    expect(w.centred).toBe(true);
    expect(w.centre).toBe(Date.UTC(2026, 0, 2, 6, 45));
    expect(w.start).toBe(Date.UTC(2026, 0, 2, 6, 30));
    expect(w.end).toBe(Date.UTC(2026, 0, 2, 7, 0));
  });

  it('never ends later than the desired wake time', () => {
    const early = Date.UTC(2026, 0, 2, 6, 50);
    const w = suggestWakeWindow(early, { bedtime: bed });
    expect(w.end).toBe(early);
    expect(w.centred).toBe(false);
    expect(w.end - w.start).toBe(30 * MIN);
  });

  it('falls back to a plain window before the wake time without a bedtime', () => {
    const w = suggestWakeWindow(wake, { windowMin: 40 });
    expect(w).toEqual({ start: wake - 40 * MIN, end: wake, centre: wake - 20 * MIN, centred: false });
  });
});
