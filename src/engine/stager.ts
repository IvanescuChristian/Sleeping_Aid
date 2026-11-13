// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import {
  BASELINE_MIN_HR_EPOCHS,
  CK_WEIGHTS,
  DEEP_HR_MARGIN_BPM,
  DEEP_SD_RATIO,
  DEEP_STILL_EPOCHS,
  REM_SD_RATIO,
  REM_STILL_EPOCHS,
  STILL_ACTIVITY,
  WAKE_THRESHOLD,
} from './config';
import type { Epoch, EpochResult } from './types';

/** Sorted-array percentile helper; the night is at most ~1000 epochs so insertion cost is irrelevant. */
class RunningQuantiles {
  private readonly v: number[] = [];
  add(x: number): void {
    let lo = 0;
    let hi = this.v.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.v[mid] as number) < x) lo = mid + 1;
      else hi = mid;
    }
    this.v.splice(lo, 0, x);
  }
  get count(): number {
    return this.v.length;
  }
  q(p: number): number {
    return this.v[Math.floor((this.v.length - 1) * p)] as number;
  }
}

/**
 * Causal stage estimator: epoch i's label depends only on epochs <= i, so the
 * live result never changes retroactively and replay matches production.
 */
export class Stager {
  private readonly activity: number[] = [];
  private stillRun = 0;
  private readonly hrMeans = new RunningQuantiles();
  private readonly hrSds = new RunningQuantiles();

  process(e: Epoch): EpochResult {
    this.activity.unshift(e.activity);
    if (this.activity.length > CK_WEIGHTS.length) this.activity.pop();

    if (!Number.isFinite(e.activity)) {
      // No motion data means no basis for a label; do not guess from HR alone.
      this.stillRun = 0;
      return { start: e.start, stage: 'unknown', confidence: 0 };
    }

    const hrOk = e.hrMean !== null && e.hrSd !== null;
    if (hrOk) {
      this.hrMeans.add(e.hrMean as number);
      this.hrSds.add(e.hrSd as number);
    }

    const weighted = this.weightedActivity();
    const still = e.activity < STILL_ACTIVITY;
    this.stillRun = still ? this.stillRun + 1 : 0;

    if (weighted >= WAKE_THRESHOLD) {
      return { start: e.start, stage: 'wake', confidence: clamp01(0.55 + 0.45 * Math.min(1, weighted / (4 * WAKE_THRESHOLD))) };
    }

    const useHr = hrOk && this.hrMeans.count >= BASELINE_MIN_HR_EPOCHS;
    if (!useHr) return this.motionOnly(e);

    const hrMean = e.hrMean as number;
    const hrSd = e.hrSd as number;
    const medMean = this.hrMeans.q(0.5);
    const p25Mean = this.hrMeans.q(0.25);
    const medSd = this.hrSds.q(0.5);

    if (this.stillRun >= DEEP_STILL_EPOCHS && hrMean <= p25Mean + DEEP_HR_MARGIN_BPM && hrSd <= medSd * DEEP_SD_RATIO) {
      return { start: e.start, stage: 'deep', confidence: 0.8 };
    }
    if (this.stillRun >= REM_STILL_EPOCHS && hrSd >= medSd * REM_SD_RATIO && hrMean >= medMean) {
      return { start: e.start, stage: 'rem', confidence: 0.65 };
    }
    // Moving, or still without matching HR evidence: light. Movement is the strongest light cue.
    return { start: e.start, stage: 'light', confidence: still ? 0.6 : 0.8 };
  }

  private motionOnly(e: Epoch): EpochResult {
    if (this.stillRun >= DEEP_STILL_EPOCHS) {
      // Without HR, long REM atonia looks identical to deep sleep, so this label is weak.
      return { start: e.start, stage: 'deep', confidence: 0.4 };
    }
    // Stillness has not lasted long enough to say deep; confidence decays as the still run grows
    // because the chance that sleep is deepening grows with it.
    const confidence = this.stillRun === 0 ? 0.7 : Math.max(0.15, 0.7 - 0.1 * this.stillRun);
    return { start: e.start, stage: 'light', confidence };
  }

  private weightedActivity(): number {
    let num = 0;
    let den = 0;
    for (let i = 0; i < this.activity.length; i++) {
      const a = this.activity[i] as number;
      if (!Number.isFinite(a)) continue;
      const w = CK_WEIGHTS[i] as number;
      num += w * a;
      den += w;
    }
    // Renormalise so gap epochs shrink the window instead of biasing toward "asleep".
    return den > 0 ? num / den : 0;
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
