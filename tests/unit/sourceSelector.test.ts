// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { describe, expect, it } from 'vitest';
import { EPOCH_MS, WATCH_FRESH_MS, WATCH_GRACE_MS, WATCH_RECOVER_EPOCHS } from '../../src/engine/config';
import { EpochAggregator } from '../../src/engine/epochs';
import { Pipeline } from '../../src/engine/pipeline';
import { SourceSelector } from '../../src/engine/sourceSelector';
import { applyWatchBatch } from '../../src/engine/watchFeed';

const T0 = 1_800_000_000_000;
const S = 1000;

/** Epoch k of the watch ends at T0 + (k+1) epochs and arrives `lag` after that, like a real batch. */
const epochStart = (k: number) => T0 + k * EPOCH_MS;
const arrival = (k: number, lag = 15 * S) => epochStart(k) + EPOCH_MS + lag;

function make(watchEnabled = true) {
  return new SourceSelector({ startedAt: T0, watchEnabled });
}
/** Delivers watch epochs [from, to) on schedule and returns the selector's answer after each. */
function deliver(sel: SourceSelector, from: number, to: number): string[] {
  const out: string[] = [];
  for (let k = from; k < to; k++) {
    sel.onWatchEpochs(arrival(k), [epochStart(k)]);
    out.push(sel.source(arrival(k)));
  }
  return out;
}

describe('SourceSelector', () => {
  it('uses the phone only when the watch is not wanted', () => {
    const sel = make(false);
    sel.onWatchEpochs(arrival(0), [epochStart(0)]);
    expect(sel.source(T0)).toBe('phone');
    expect(sel.source(T0 + 10 * 3_600_000)).toBe('phone');
    expect(sel.switches).toBe(0);
  });

  it('waits for the watch during the grace period, then falls back to the phone', () => {
    const sel = make();
    expect(sel.source(T0 + WATCH_GRACE_MS - 1)).toBe('watch');
    expect(sel.watchSeen).toBe(false);
    expect(sel.source(T0 + WATCH_GRACE_MS)).toBe('phone');
  });

  it('stays on the watch while fresh epochs keep arriving', () => {
    const sel = make();
    expect(new Set(deliver(sel, 0, 120))).toEqual(new Set(['watch']));
    expect(sel.switches).toBe(0);
  });

  it('goes stale exactly at the timeout and then uses the phone', () => {
    const sel = make();
    deliver(sel, 0, 10);
    const last = arrival(9);
    expect(sel.source(last + WATCH_FRESH_MS - 1)).toBe('watch');
    expect(sel.source(last + WATCH_FRESH_MS)).toBe('phone');
  });

  it('returns to the watch only after the recovery hysteresis', () => {
    const sel = make();
    deliver(sel, 0, 10);
    // silent from epoch 10 to 29 (about 10 min), the phone covers it
    expect(sel.source(arrival(29))).toBe('phone');
    const answers = deliver(sel, 30, 36);
    // epochs 30, 31 are not enough; the third fresh one, 60 s after the first, switches back
    expect(answers.slice(0, WATCH_RECOVER_EPOCHS - 1)).toEqual(['phone', 'phone']);
    expect(answers[WATCH_RECOVER_EPOCHS - 1]).toBe('watch');
    expect(sel.switches).toBe(2);
  });

  it('does not count a backlog flush as proof of life', () => {
    const sel = make();
    deliver(sel, 0, 10);
    const now = arrival(100);
    expect(sel.source(now)).toBe('phone');
    // The reconnected watch dumps 50 buffered epochs from the past hour in one batch.
    sel.onWatchEpochs(now, Array.from({ length: 50 }, (_, i) => epochStart(40 + i)));
    expect(sel.source(now)).toBe('phone');
    expect(sel.watchSeen).toBe(true); // seen earlier, but nothing in the backlog was fresh
  });

  it('ignores repeated epochs, so a duplicate cannot satisfy the hysteresis', () => {
    const sel = make();
    deliver(sel, 0, 3);
    const t = arrival(40);
    for (let i = 0; i < 5; i++) sel.onWatchEpochs(t + i * S, [epochStart(39)]);
    expect(sel.source(t + 10 * S)).toBe('phone');
  });

  it('a watch that is up for under a minute at a time never gets back in', () => {
    const sel = make();
    deliver(sel, 0, 10);
    let k = 30;
    // Two epochs, then a silence longer than the timeout, over and over.
    for (let round = 0; round < 8; round++) {
      deliver(sel, k, k + 2);
      expect(sel.source(arrival(k + 1))).toBe('phone');
      k += 2 + 6;
    }
    expect(sel.switches).toBe(1);
  });

  it('flapping with long enough bursts switches a bounded number of times', () => {
    const sel = make();
    // Two hours: 4 min of watch data, then 3.5 min silence, repeatedly. Count switches against the bound.
    let k = 0;
    for (let round = 0; round < 17; round++) {
      deliver(sel, k, k + 8);
      k += 8 + 7;
      sel.source(arrival(k - 1));
    }
    const hours = (k * EPOCH_MS) / 3_600_000;
    // At most one cycle (two switches) per recovery plus one timeout, about 3.5 min.
    expect(sel.switches).toBeLessThanOrEqual(Math.ceil((hours * 60) / 3.5) * 2);
    expect(sel.switches).toBeGreaterThan(2);
  });

  it('a late epoch after a long gap starts a recovery instead of refreshing the watch', () => {
    const sel = make();
    deliver(sel, 0, 5);
    deliver(sel, 40, 41); // arrives well after the timeout
    expect(sel.source(arrival(40))).toBe('phone');
  });
});

describe('EpochAggregator source ownership', () => {
  it('keeps one source per epoch, refuses the other and counts it', () => {
    const a = new EpochAggregator();
    a.ingestActivity({ t: T0 + 5 * S, activity: 0.02, samples: 100 });
    a.ingestMotion({ t: T0 + 6 * S, ax: 0, ay: 0, az: 9.81 });
    a.ingestMotion({ t: T0 + 7 * S, ax: 3, ay: 0, az: 9.81 });
    expect(a.crossSource).toBe(2);
    const [e] = a.advance(T0 + 40 * S);
    expect(e?.source).toBe('watch');
    expect(e?.motionSamples).toBe(100);
    expect(e?.activity).toBeCloseTo(0.02, 12);
  });

  it('labels the next epoch after the one that was refused with its own source', () => {
    const a = new EpochAggregator();
    const out = [
      ...a.ingestMotion({ t: T0 + 5 * S, ax: 0, ay: 0, az: 9.81 }),
      ...a.ingestActivity({ t: T0 + EPOCH_MS + 5 * S, activity: 0.01, samples: 50 }),
      ...a.advance(T0 + 3 * EPOCH_MS),
    ];
    expect(out.map((e) => e.source)).toEqual(['phone', 'watch']);
  });

  it('marks gap epochs and heart-rate-only epochs as source null', () => {
    const a = new EpochAggregator();
    const out = [...a.ingestHr({ t: T0 + 1000, bpm: 60 }), ...a.advance(T0 + 4 * EPOCH_MS)];
    expect(out.map((e) => e.source)).toEqual([null, null, null]);
  });
});

describe('applyWatchBatch', () => {
  const batch = (k: number) => ({ epochs: [{ start: epochStart(k), activity: 0.5, samples: 100 }], hr: [{ t: epochStart(k) + 1000, bpm: 58 }] });

  it('admits wrist activity while the watch is the source, shifted by the fixed lag', () => {
    const seen: Array<{ src: string | null; act: number }> = [];
    const pipe = new Pipeline({ windowStart: T0 + 1e9, windowEnd: T0 + 1e9 + 30 * 60_000, stager: { process: (e) => (seen.push({ src: e.source ?? null, act: e.activity }), { start: e.start, stage: 'light', confidence: 0.7 }) } });
    const sel = make();
    expect(applyWatchBatch(pipe, sel, batch(0), arrival(0), 0)).toBe(true);
    pipe.tick(T0 + 5 * EPOCH_MS);
    expect(seen.find((x) => x.src === 'watch')?.act).toBeCloseTo(0.5, 12);
  });

  it('keeps stale-watch activity out but still takes its heart rate', () => {
    const results: Array<{ src: string | null; hr: number | null }> = [];
    const pipe = new Pipeline({ windowStart: T0 + 1e9, windowEnd: T0 + 1e9 + 30 * 60_000, stager: { process: (e) => (results.push({ src: e.source ?? null, hr: e.hrMean }), { start: e.start, stage: 'light', confidence: 0.7 }) } });
    const sel = make();
    const now = arrival(40);
    expect(sel.source(now)).toBe('phone');
    expect(applyWatchBatch(pipe, sel, batch(39), now, 0)).toBe(false);
    pipe.tick(now + 5 * EPOCH_MS);
    expect(results.some((r) => r.src === 'watch')).toBe(false);
    expect(results.some((r) => r.hr === 58)).toBe(true);
    expect(pipe.aggregator.crossSource).toBe(0);
  });
});
