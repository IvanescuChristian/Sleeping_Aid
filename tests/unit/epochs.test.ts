// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { describe, expect, it } from 'vitest';
import { EPOCH_MS } from '../../src/engine/config';
import { EpochAggregator } from '../../src/engine/epochs';
import type { MotionSample } from '../../src/engine/types';

const T0 = 1_800_000_000_000 - (1_800_000_000_000 % EPOCH_MS);

function still(t: number): MotionSample {
  return { t, ax: 0, ay: 0, az: 9.81 };
}

describe('EpochAggregator', () => {
  it('closes an epoch only after time passes its boundary', () => {
    const a = new EpochAggregator();
    expect(a.ingestMotion(still(T0 + 1000))).toEqual([]);
    expect(a.ingestMotion(still(T0 + EPOCH_MS - 1))).toEqual([]);
    // Inside the reorder grace: still open.
    expect(a.ingestMotion(still(T0 + EPOCH_MS + 500))).toEqual([]);
    const closed = a.ingestMotion(still(T0 + EPOCH_MS + 5000));
    expect(closed).toHaveLength(1);
    expect(closed[0]?.start).toBe(T0);
    expect(closed[0]?.motionSamples).toBe(2);
  });

  it('is insensitive to motion/HR interleaving order', () => {
    const run = (order: 'motionFirst' | 'hrFirst' | 'mixed') => {
      const a = new EpochAggregator();
      const out = [];
      const motion = Array.from({ length: 20 }, (_, i) => ({ t: T0 + i * 1000, ax: 0, ay: 0, az: 9.81 + (i % 2) * 0.1 }));
      const hr = Array.from({ length: 20 }, (_, i) => ({ t: T0 + i * 1000 + 300, bpm: 60 + (i % 5) }));
      if (order === 'motionFirst') {
        motion.forEach((m) => out.push(...a.ingestMotion(m)));
        hr.forEach((h) => out.push(...a.ingestHr(h)));
      } else if (order === 'hrFirst') {
        hr.forEach((h) => out.push(...a.ingestHr(h)));
        motion.forEach((m) => out.push(...a.ingestMotion(m)));
      } else {
        for (let i = 0; i < 20; i++) {
          out.push(...a.ingestHr(hr[i]!));
          out.push(...a.ingestMotion(motion[i]!));
        }
      }
      out.push(...a.advance(T0 + 3 * EPOCH_MS));
      return out.find((e) => e.start === T0);
    };
    const base = run('motionFirst');
    expect(base?.hrSamples).toBe(20);
    expect(base?.motionSamples).toBe(20);
    expect(run('hrFirst')).toEqual(base);
    expect(run('mixed')).toEqual(base);
  });

  it('keeps a slightly late HR packet in its epoch within the grace window', () => {
    const a = new EpochAggregator();
    a.ingestMotion(still(T0 + 1000));
    a.ingestMotion(still(T0 + EPOCH_MS + 1000)); // time moved on, epoch 0 still open
    a.ingestHr({ t: T0 + EPOCH_MS - 500, bpm: 60 });
    const out = a.advance(T0 + 3 * EPOCH_MS);
    expect(out[0]?.hrSamples).toBe(1);
  });

  it('gives identical activity for any phone orientation', () => {
    const rot = (x: number, y: number, z: number, k: number): [number, number, number] => {
      // Three different fixed rotations (axis permutations with sign flips).
      if (k === 0) return [x, y, z];
      if (k === 1) return [z, -x, y];
      return [-y, -z, x];
    };
    const activity = (k: number) => {
      const a = new EpochAggregator();
      for (let i = 0; i < 300; i++) {
        const shake = Math.sin(i / 3) * 0.2 * (i > 100 ? 1 : 0);
        const [ax, ay, az] = rot(0.5, 0.3, 9.7 + shake, k);
        a.ingestMotion({ t: T0 + i * 100, ax, ay, az });
      }
      return a.advance(T0 + 5 * EPOCH_MS)[0]!.activity;
    };
    expect(activity(1)).toBeCloseTo(activity(0), 12);
    expect(activity(2)).toBeCloseTo(activity(0), 12);
    expect(activity(0)).toBeGreaterThan(0.05);
  });

  it('normalises activity per sample so sensor rate does not matter', () => {
    const at = (hz: number) => {
      const a = new EpochAggregator();
      const n = hz * 30;
      for (let i = 0; i < n; i++) {
        const t = T0 + (i * EPOCH_MS) / n;
        a.ingestMotion({ t, ax: 0, ay: 0, az: 9.81 + (Math.floor(t / 1000) % 2 ? 0.2 : -0.2) * 0.5 });
      }
      return a.advance(T0 + 3 * EPOCH_MS)[0]!.activity;
    };
    expect(at(50)).toBeCloseTo(at(5), 1);
  });

  it('reports sensor gaps as NaN activity and null HR, including empty epochs between samples', () => {
    const a = new EpochAggregator();
    const out = [...a.ingestMotion(still(T0 + 1000)), ...a.ingestMotion(still(T0 + 3 * EPOCH_MS + 1000)), ...a.advance(T0 + 5 * EPOCH_MS)];
    expect(out.map((e) => e.start)).toEqual([T0, T0 + EPOCH_MS, T0 + 2 * EPOCH_MS, T0 + 3 * EPOCH_MS]);
    expect(Number.isNaN(out[1]!.activity)).toBe(true);
    expect(out[1]!.hrMean).toBeNull();
    expect(out[1]!.motionSamples).toBe(0);
  });

  it('rejects non-finite samples and drops samples for already-emitted epochs', () => {
    const a = new EpochAggregator();
    a.ingestMotion(still(T0 + 1000));
    a.ingestMotion({ t: T0 + 2000, ax: NaN, ay: 0, az: 9.81 });
    a.ingestHr({ t: T0 + 2000, bpm: Number.NaN });
    expect(a.rejected).toBe(2);
    a.advance(T0 + 3 * EPOCH_MS);
    a.ingestMotion(still(T0 + 5000));
    expect(a.late).toBe(1);
  });

  it('survives a huge forward time jump without unbounded work', () => {
    const a = new EpochAggregator();
    a.ingestMotion(still(T0));
    const out = a.advance(T0 + 400 * 24 * 3600_000);
    expect(out.length).toBeLessThanOrEqual(2_881);
  });
});
