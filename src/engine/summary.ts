// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import {
  EPOCH_MS,
  MIN_AWAKENING_EPOCHS,
  MIN_REM_BLOCK_EPOCHS,
  ONSET_SUSTAINED_EPOCHS,
  QUALITY_TARGET_RESTORATIVE_SHARE,
  QUALITY_TARGET_SLEEP_MIN,
  QUALITY_WEIGHTS,
  REM_BLOCK_MERGE_EPOCHS,
} from './config';
import type { EpochResult, Stage } from './types';

export interface NightSummary {
  startMs: number;
  totalSleepMin: number;
  /** Minutes from recording start to the first 10 min of unbroken sleep; null if sleep never became sustained. */
  sleepOnsetLatencyMin: number | null;
  /** Sleep minutes / recorded minutes (sensor gaps excluded), percent. */
  efficiency: number;
  minutesPerStage: Record<Stage, number>;
  awakenings: number;
  /** Mean time between ends of successive REM periods; null with fewer than one complete cycle. */
  meanCycleMin: number | null;
  /** 0-100, see qualityScore. */
  quality: number;
  hypnogram: Stage[];
}

const EPOCH_MIN = EPOCH_MS / 60_000;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const isSleep = (s: Stage) => s === 'light' || s === 'deep' || s === 'rem';

/**
 * Quality = 100 * (0.35 duration + 0.25 efficiency + 0.20 restorative + 0.10 latency + 0.10 continuity), where
 *  duration    = min(1, sleepMin / 450)
 *  efficiency  = clamp((eff% - 65) / 30)           (65% -> 0, 95% -> 1)
 *  restorative = min(1, (deep+rem)/sleep / 0.40)
 *  latency     = 1 - clamp((onsetMin - 10) / 35)   (<=10 min -> 1, >=45 min -> 0, never asleep -> 0)
 *  continuity  = 1 - min(1, awakenings / 6)
 * Rounded to an integer. A transparent formula beats a tuned black box for a self-reported tool.
 */
export function qualityScore(p: {
  totalSleepMin: number;
  efficiency: number;
  restorativeShare: number;
  latencyMin: number | null;
  awakenings: number;
}): number {
  const w = QUALITY_WEIGHTS;
  const duration = Math.min(1, p.totalSleepMin / QUALITY_TARGET_SLEEP_MIN);
  const efficiency = clamp01((p.efficiency - 65) / 30);
  const restorative = Math.min(1, p.restorativeShare / QUALITY_TARGET_RESTORATIVE_SHARE);
  const latency = p.latencyMin === null ? 0 : 1 - clamp01((p.latencyMin - 10) / 35);
  const continuity = 1 - Math.min(1, p.awakenings / 6);
  const score = w.duration * duration + w.efficiency * efficiency + w.restorative * restorative + w.latency * latency + w.continuity * continuity;
  return Math.round(100 * score);
}

export function summarizeNight(results: readonly EpochResult[]): NightSummary {
  const hypnogram = results.map((r) => r.stage);
  const minutesPerStage: Record<Stage, number> = { wake: 0, light: 0, deep: 0, rem: 0, unknown: 0 };
  for (const s of hypnogram) minutesPerStage[s] += EPOCH_MIN;

  const totalSleepMin = minutesPerStage.light + minutesPerStage.deep + minutesPerStage.rem;
  const recordedMin = totalSleepMin + minutesPerStage.wake;
  const efficiency = recordedMin > 0 ? (100 * totalSleepMin) / recordedMin : 0;

  // Onset: first run of sustained sleep, measured from the first epoch.
  let onsetIdx = -1;
  let run = 0;
  for (let i = 0; i < hypnogram.length; i++) {
    run = isSleep(hypnogram[i] as Stage) ? run + 1 : 0;
    if (run >= ONSET_SUSTAINED_EPOCHS) {
      onsetIdx = i - ONSET_SUSTAINED_EPOCHS + 1;
      break;
    }
  }
  const sleepOnsetLatencyMin = onsetIdx >= 0 ? onsetIdx * EPOCH_MIN : null;

  const awakenings = countAwakenings(hypnogram, onsetIdx);
  const meanCycleMin = meanCycle(hypnogram, onsetIdx);
  const restorativeShare = totalSleepMin > 0 ? (minutesPerStage.deep + minutesPerStage.rem) / totalSleepMin : 0;

  return {
    startMs: results[0]?.start ?? 0,
    totalSleepMin,
    sleepOnsetLatencyMin,
    efficiency,
    minutesPerStage,
    awakenings,
    meanCycleMin,
    quality: qualityScore({ totalSleepMin, efficiency, restorativeShare, latencyMin: sleepOnsetLatencyMin, awakenings }),
    hypnogram,
  };
}

function countAwakenings(h: readonly Stage[], onsetIdx: number): number {
  if (onsetIdx < 0) return 0;
  let count = 0;
  let wakeRun = 0;
  for (let i = onsetIdx; i < h.length; i++) {
    const s = h[i] as Stage;
    if (s === 'unknown') continue; // gaps neither start nor end an awakening
    if (s === 'wake') {
      wakeRun++;
      if (wakeRun === MIN_AWAKENING_EPOCHS) count++;
    } else {
      wakeRun = 0;
    }
  }
  return count;
}

function meanCycle(h: readonly Stage[], onsetIdx: number): number | null {
  if (onsetIdx < 0) return null;
  // Collect REM runs, merge near ones, keep the long ones; each REM period closes a cycle.
  const runs: Array<{ start: number; end: number }> = [];
  let i = onsetIdx;
  while (i < h.length) {
    if (h[i] === 'rem') {
      let j = i;
      while (j < h.length && h[j] === 'rem') j++;
      const prev = runs[runs.length - 1];
      if (prev && i - prev.end < REM_BLOCK_MERGE_EPOCHS && !h.slice(prev.end, i).includes('deep')) prev.end = j;
      else runs.push({ start: i, end: j });
      i = j;
    } else i++;
  }
  const ends = runs.filter((r) => r.end - r.start >= MIN_REM_BLOCK_EPOCHS).map((r) => r.end);
  if (ends.length === 0) return null;
  const lengths: number[] = [];
  let prevEnd = onsetIdx;
  for (const e of ends) {
    lengths.push((e - prevEnd) * EPOCH_MIN);
    prevEnd = e;
  }
  return lengths.reduce((a, b) => a + b, 0) / lengths.length;
}
