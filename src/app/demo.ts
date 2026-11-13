// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import type { Pipeline } from '../engine/pipeline';
import { generateNight, type SyntheticNight } from '../sim/syntheticNight';

const MIN = 60_000;

/** Replays a seeded synthetic night against a virtual clock, feeding the same Pipeline the live sensors feed. */
export class DemoFeeder {
  readonly night: SyntheticNight;
  readonly windowStart: number;
  readonly windowEnd: number;
  now: number;
  private mi = 0;
  private hi = 0;

  constructor(realNow: number, seed = 7) {
    this.night = generateNight({ seed, bedtime: realNow, durationMin: 450, hr: true, motion: true, motionHz: 2 });
    this.now = this.night.startMs;
    this.windowEnd = this.night.startMs + 420 * MIN;
    this.windowStart = this.windowEnd - 30 * MIN;
  }

  /** Moves virtual time forward (coarsely until the window is near) and delivers the samples in between. */
  advance(pipe: Pipeline): void {
    const step = this.now < this.windowStart - 5 * MIN ? 2 * MIN : 15_000;
    this.now = Math.min(this.now + step, this.windowEnd);
    const { motion, hr } = this.night;
    for (;;) {
      const m = motion[this.mi];
      const h = hr[this.hi];
      const mt = m && m.t <= this.now ? m.t : Infinity;
      const ht = h && h.t <= this.now ? h.t : Infinity;
      if (mt === Infinity && ht === Infinity) break;
      if (mt <= ht && m) {
        pipe.ingestMotion(m);
        this.mi++;
      } else if (h) {
        pipe.ingestHr(h);
        this.hi++;
      }
    }
  }
}
