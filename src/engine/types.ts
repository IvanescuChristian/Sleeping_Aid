// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).

/** Estimated sleep stage. 'unknown' marks an epoch with no usable sensor data. */
export type Stage = 'wake' | 'light' | 'deep' | 'rem' | 'unknown';

/** Accelerometer reading in m/s^2 including gravity; t is epoch milliseconds. */
export interface MotionSample {
  t: number;
  ax: number;
  ay: number;
  az: number;
}

/** Heart-rate reading in beats per minute; t is epoch milliseconds. */
export interface HrSample {
  t: number;
  bpm: number;
}

/** One fixed-length slice of aggregated sensor data. */
export interface Epoch {
  start: number;
  /** Mean absolute deviation of |accel| from gravity; NaN when no motion samples arrived. */
  activity: number;
  hrMean: number | null;
  hrSd: number | null;
  motionSamples: number;
  hrSamples: number;
}

/** Stager output for one epoch. */
export interface EpochResult {
  start: number;
  stage: Stage;
  /** 0..1; how much the stager trusts the label. */
  confidence: number;
}

export type Clock = () => number;
