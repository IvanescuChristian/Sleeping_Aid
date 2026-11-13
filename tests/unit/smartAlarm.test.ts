// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { describe, expect, it } from 'vitest';
import { EPOCH_MS, MIN_WINDOW_MS } from '../../src/engine/config';
import { Pipeline } from '../../src/engine/pipeline';
import { AlarmWindowError, SmartAlarm } from '../../src/engine/smartAlarm';
import type { EpochResult, Stage } from '../../src/engine/types';
import { replayNight } from '../../src/sim/replay';
import { generateNight, truthStageAt } from '../../src/sim/syntheticNight';

const MIN = 60_000;
const NIGHTS = 50;

/** Window placed late in a 7.5 h night, shifted per seed so it lands on different cycle phases. */
function windowFor(seed: number, startMs: number) {
  const windowStart = startMs + (330 + (seed % 7) * 8) * MIN;
  return { windowStart, windowEnd: windowStart + 30 * MIN };
}

function campaign(hr: boolean) {
  let smart = 0;
  let fallback = 0;
  let good = 0;
  let deep = 0;
  let outside = 0;
  for (let seed = 1; seed <= NIGHTS; seed++) {
    const night = generateNight({ seed, bedtime: 0, durationMin: 450, motionHz: 2, hr });
    const w = windowFor(seed, night.startMs);
    const r = replayNight(night, w);
    const d = r.decision!;
    if (d.at < w.windowStart || d.at > w.windowEnd) outside++;
    if (d.reason === 'fallback') {
      fallback++;
      continue;
    }
    smart++;
    const truth: Stage = truthStageAt(night, d.at);
    if (truth === 'light' || truth === 'wake') good++;
    if (truth === 'deep') deep++;
  }
  return { smart, fallback, good, deep, outside };
}

describe('SmartAlarm on synthetic nights', () => {
  it('with HR: always decides inside the window and wakes from light/wake sleep', () => {
    const c = campaign(true);
    console.info(
      'alarm (HR) smart=' + c.smart + ' fallback=' + c.fallback + ' light/wake-at-trigger=' + (c.good / c.smart).toFixed(3) + ' deep-at-trigger=' + (c.deep / c.smart).toFixed(3),
    );
    expect(c.outside).toBe(0);
    expect(c.smart + c.fallback).toBe(NIGHTS);
    expect(c.good / c.smart).toBeGreaterThanOrEqual(0.85);
    expect(1 - c.deep / c.smart).toBeGreaterThanOrEqual(0.95);
    // The smart path should actually be used, otherwise the feature is just a fixed alarm.
    expect(c.smart / NIGHTS).toBeGreaterThanOrEqual(0.7);
  });

  it('(HR-less) still triggers smartly and avoids deep sleep', () => {
    const c = campaign(false);
    console.info('alarm (no HR) smart=' + c.smart + ' fallback=' + c.fallback + ' light/wake-at-trigger=' + (c.good / c.smart).toFixed(3) + ' deep-at-trigger=' + (c.deep / c.smart).toFixed(3));
    expect(c.outside).toBe(0);
    expect(c.smart).toBeGreaterThan(0);
    expect(c.good / c.smart).toBeGreaterThanOrEqual(0.8);
    expect(1 - c.deep / c.smart).toBeGreaterThanOrEqual(0.95);
  });
});

describe('Hard fallback', () => {
  const start = 1_800_000_000_000;
  const end = start + 30 * MIN;

  it('fires at exactly windowEnd with no data at all', () => {
    const a = new SmartAlarm({ windowStart: start, windowEnd: end });
    expect(a.tick(start + MIN)).toBeNull();
    expect(a.tick(end - 1)).toBeNull();
    expect(a.tick(end)).toEqual({ reason: 'fallback', at: end, stageAtTrigger: 'unknown' });
  });

  it('fires with all sensors dropped mid-night', () => {
    const night = generateNight({
      seed: 3,
      bedtime: 0,
      durationMin: 450,
      motionHz: 2,
      dropouts: [{ fromMs: 120 * MIN, toMs: 1_000 * MIN }],
    });
    const w = windowFor(3, night.startMs);
    const r = replayNight(night, w);
    expect(r.decision).toEqual({ reason: 'fallback', at: w.windowEnd, stageAtTrigger: expect.any(String) });
    // Gap epochs are reported as unknown rather than silently skipped.
    expect(r.epochs.at(-1)?.stage).toBe('unknown');
  });

  it('fires on the first tick after a clock jump past the end, and only once', () => {
    const a = new SmartAlarm({ windowStart: start, windowEnd: end });
    expect(a.tick(start + MIN)).toBeNull();
    const d = a.tick(end + 6 * 3600_000);
    expect(d?.reason).toBe('fallback');
    expect(a.tick(end + 7 * 3600_000)).toBeNull();
    expect(a.tick(end)).toBeNull();
    expect(a.getState().fired).toEqual(d);
  });

  it('uses the injected clock when tick has no argument', () => {
    let now = start;
    const a = new SmartAlarm({ windowStart: start, windowEnd: end, clock: () => now });
    expect(a.tick()).toBeNull();
    now = end + 1;
    expect(a.tick()?.reason).toBe('fallback');
  });

  it('survives malformed ingest (counted, never thrown)', () => {
    const a = new SmartAlarm({ windowStart: start, windowEnd: end });
    const bad: unknown[] = [null, undefined, { start: NaN, stage: 'light', confidence: 1 }, { start, stage: 'bogus', confidence: 1 }, { start, stage: 'light', confidence: NaN }];
    for (const b of bad) expect(a.ingest(b as EpochResult)).toBe(false);
    expect(a.getState().errorCount).toBe(bad.length);
    expect(a.tick(end)?.reason).toBe('fallback');
  });

  it('fires even if the stager throws on every epoch and the aggregator sees NaN samples', () => {
    const p = new Pipeline({
      windowStart: start,
      windowEnd: end,
      stager: {
        process() {
          throw new Error('stager defect');
        },
      },
    });
    for (let t = start; t < end; t += 1000) {
      p.ingestMotion({ t, ax: NaN, ay: 0, az: 9.8 });
      p.ingestMotion({ t, ax: 0, ay: 0, az: 9.8 });
      p.ingestHr({ t, bpm: 60 });
      p.tick(t);
    }
    expect(p.pipelineErrors).toBeGreaterThan(0);
    expect(p.tick(end)?.reason).toBe('fallback');
  });
});

describe('Smart trigger rules', () => {
  const start = 1_800_000_000_000;
  const end = start + 30 * MIN;
  const feed = (a: SmartAlarm, stages: Stage[], first: number, conf = 0.8) =>
    stages.forEach((stage, i) => a.ingest({ start: first + i * EPOCH_MS, stage, confidence: conf }));

  it('does not fire before the window opens, even on perfect light sleep', () => {
    const a = new SmartAlarm({ windowStart: start, windowEnd: end });
    const first = start - 10 * EPOCH_MS;
    feed(a, Array(10).fill('light'), first);
    expect(a.tick(start - 1)).toBeNull();
  });

  it('fires inside the window after a light run with no recent deep sleep', () => {
    const a = new SmartAlarm({ windowStart: start, windowEnd: end });
    const first = start + 5 * MIN;
    feed(a, Array(4).fill('light'), first);
    const now = first + 4 * EPOCH_MS + 1000;
    expect(a.tick(now)).toEqual({ reason: 'smart', at: now, stageAtTrigger: 'light' });
  });

  it('waits out the deep cool-down, then fires', () => {
    const a = new SmartAlarm({ windowStart: start, windowEnd: end });
    const first = start + 5 * MIN;
    feed(a, ['deep', ...Array(5).fill('light')], first);
    expect(a.tick(first + 6 * EPOCH_MS + 1000)).toBeNull();
    feed(a, Array(5).fill('light'), first + 6 * EPOCH_MS);
    expect(a.tick(first + 11 * EPOCH_MS + 1000)?.reason).toBe('smart');
  });

  it('refuses stale data and low-confidence light', () => {
    const a = new SmartAlarm({ windowStart: start, windowEnd: end });
    const first = start + 5 * MIN;
    feed(a, Array(4).fill('light'), first);
    expect(a.tick(first + 4 * EPOCH_MS + 3 * EPOCH_MS)).toBeNull(); // data too old
    const b = new SmartAlarm({ windowStart: start, windowEnd: end });
    feed(b, Array(4).fill('light'), first, 0.2);
    expect(b.tick(first + 4 * EPOCH_MS + 1000)).toBeNull();
  });

  it('counts wake as a good moment but not rem or unknown', () => {
    const mk = (s: Stage) => {
      const a = new SmartAlarm({ windowStart: start, windowEnd: end });
      const first = start + 5 * MIN;
      feed(a, ['light', 'light', 'light', s], first);
      return a.tick(first + 4 * EPOCH_MS + 1000)?.reason ?? null;
    };
    expect(mk('wake')).toBe('smart');
    expect(mk('rem')).toBeNull();
    expect(mk('unknown')).toBeNull();
  });
});

describe('Window validation', () => {
  const s = 1_800_000_000_000;
  const code = (a: number, b: number) => {
    try {
      new SmartAlarm({ windowStart: a, windowEnd: b });
    } catch (e) {
      expect(e).toBeInstanceOf(AlarmWindowError);
      return (e as AlarmWindowError).code;
    }
    return null;
  };
  it('rejects bad windows with typed errors', () => {
    expect(code(s, s)).toBe('end_not_after_start');
    expect(code(s, s - MIN)).toBe('end_not_after_start');
    expect(code(s, s + MIN_WINDOW_MS - 1)).toBe('too_short');
    expect(code(s, s + 3 * 60 * MIN + 1)).toBe('too_long');
    expect(code(NaN, s)).toBe('non_finite');
  });
  it('accepts the boundaries', () => {
    expect(code(s, s + MIN_WINDOW_MS)).toBeNull();
    expect(code(s, s + 3 * 60 * MIN)).toBeNull();
  });
});
