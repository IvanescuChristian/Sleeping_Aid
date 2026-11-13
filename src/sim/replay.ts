// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { Pipeline } from '../engine/pipeline';
import type { AlarmDecision } from '../engine/smartAlarm';
import type { EpochResult, Stage } from '../engine/types';
import type { SyntheticNight } from './syntheticNight';

export interface ReplayOptions {
  windowStart: number;
  windowEnd: number;
  /** Virtual tick period; mirrors a foreground timer on the device. */
  tickMs?: number;
}

export interface ReplayResult {
  decision: AlarmDecision | null;
  epochs: EpochResult[];
  truth: Stage[];
  night: SyntheticNight;
  pipelineErrors: number;
}

/**
 * Replays a night through the full pipeline against a virtual clock. Samples are
 * delivered in time order up to each tick, so no wall-clock waiting is involved.
 */
export function replayNight(night: SyntheticNight, opts: ReplayOptions): ReplayResult {
  const tickMs = opts.tickMs ?? 5_000;
  let now = night.startMs;
  const pipe = new Pipeline({ windowStart: opts.windowStart, windowEnd: opts.windowEnd, clock: () => now });

  let mi = 0;
  let hi = 0;
  let decision: AlarmDecision | null = null;
  for (let t = night.startMs; !decision; t = Math.min(t + tickMs, opts.windowEnd)) {
    now = t;
    // Merge the two streams by timestamp so interleaving matches a real device.
    while (true) {
      const m = night.motion[mi];
      const h = night.hr[hi];
      const mOk = m !== undefined && m.t <= t;
      const hOk = h !== undefined && h.t <= t;
      if (!mOk && !hOk) break;
      if (mOk && (!hOk || (m as { t: number }).t <= (h as { t: number }).t)) {
        pipe.ingestMotion(m);
        mi++;
      } else {
        pipe.ingestHr(h as never);
        hi++;
      }
    }
    decision = pipe.tick(t);
    if (t >= opts.windowEnd) break;
  }
  return { decision, epochs: pipe.results, truth: night.truth, night, pipelineErrors: pipe.pipelineErrors };
}

/** Runs only the stager over a whole night (no alarm) for accuracy measurement. */
export function stageNight(night: SyntheticNight): EpochResult[] {
  const end = night.startMs + night.truth.length * 30_000 + 60_000;
  // Slice to the truth length: ticks past the recording close trailing gap epochs that have no truth.
  return replayNight(night, { windowStart: end, windowEnd: end + 3_600_000 }).epochs.slice(0, night.truth.length);
}
