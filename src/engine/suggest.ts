// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import {
  DEFAULT_CYCLE_MIN,
  DEFAULT_LATENCY_MIN,
  DEFAULT_WINDOW_MIN,
  MAX_CYCLE_MIN,
  MAX_WINDOW_MS,
  MIN_CYCLE_MIN,
  MIN_WINDOW_MS,
} from './config';
import type { NightSummary } from './summary';

const MIN_MS = 60_000;

export interface BedtimeSuggestion {
  cycles: number;
  bedtime: number;
  sleepMin: number;
}

export interface WindowSuggestion {
  start: number;
  end: number;
  /** Predicted light-sleep moment, or the window midpoint when no bedtime is known. */
  centre: number;
  /** True when the window is actually centred on the predicted light point. */
  centred: boolean;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** Personal cycle length: mean of observed cycles, clamped so one odd night cannot yield absurd advice. */
export function personalCycleMin(history: readonly NightSummary[] = []): number {
  const obs = history.map((h) => h.meanCycleMin).filter((x): x is number => x !== null && Number.isFinite(x));
  if (obs.length === 0) return DEFAULT_CYCLE_MIN;
  return Math.max(MIN_CYCLE_MIN, Math.min(MAX_CYCLE_MIN, mean(obs)));
}

/** Median (robust to a single insomniac night) sleep-onset latency. */
export function personalLatencyMin(history: readonly NightSummary[] = []): number {
  const obs = history.map((h) => h.sleepOnsetLatencyMin).filter((x): x is number => x !== null && Number.isFinite(x));
  return obs.length === 0 ? DEFAULT_LATENCY_MIN : median(obs);
}

/** Bedtimes that let k whole cycles finish just before the desired wake time (k = 5 and 6). */
export function suggestBedtimes(wakeTime: number, history: readonly NightSummary[] = []): BedtimeSuggestion[] {
  const cycle = personalCycleMin(history);
  const latency = personalLatencyMin(history);
  return [5, 6].map((k) => ({
    cycles: k,
    bedtime: Math.round(wakeTime - (k * cycle + latency) * MIN_MS),
    sleepMin: k * cycle,
  }));
}

/**
 * Wake window around the cycle boundary (a light-sleep moment) nearest the desired wake time.
 * The desired time is the latest acceptable wake-up, so the window is slid earlier if
 * centring on the boundary would push its end past it.
 */
export function suggestWakeWindow(
  wakeTime: number,
  opts: { bedtime?: number; history?: readonly NightSummary[]; windowMin?: number } = {},
): WindowSuggestion {
  const windowMs = Math.max(MIN_WINDOW_MS, Math.min(MAX_WINDOW_MS, (opts.windowMin ?? DEFAULT_WINDOW_MIN) * MIN_MS));
  const half = windowMs / 2;
  if (opts.bedtime === undefined) {
    return { start: wakeTime - windowMs, end: wakeTime, centre: wakeTime - half, centred: false };
  }
  const cycleMs = personalCycleMin(opts.history) * MIN_MS;
  const first = opts.bedtime + personalLatencyMin(opts.history) * MIN_MS + cycleMs;
  // Aim the window so it ends near the desired time, then snap its centre to the closest boundary.
  const target = wakeTime - half;
  const n = Math.max(0, Math.round((target - first) / cycleMs));
  let centre = first + n * cycleMs;
  let end = centre + half;
  let centred = true;
  if (end > wakeTime) {
    end = wakeTime;
    centre = end - half;
    centred = false;
  }
  return { start: end - windowMs, end, centre, centred };
}
