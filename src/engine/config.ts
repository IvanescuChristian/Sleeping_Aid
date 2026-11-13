// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).

// All tunables live here so calibration against real nights touches one file.

/** 30 s is the standard actigraphy epoch: long enough to average sensor noise, short enough to catch brief arousals. */
export const EPOCH_MS = 30_000;

/** Cross-stream clock skew tolerance: a late HR packet must still land in the epoch it belongs to. */
export const REORDER_GRACE_MS = 2_000;

/** Gravity high-pass time constant; slow enough to ignore body movement, fast enough to follow a turned phone. */
export const GRAVITY_TAU_MS = 4_000;

/** Upper bound on gap epochs emitted in one jump, so a bogus timestamp cannot spin the loop. */
export const MAX_GAP_EPOCHS = 2_880;

/** Fewer HR samples than this give a meaningless SD. */
export const MIN_HR_SAMPLES_FOR_SD = 5;

/** Causal Cole-Kripke-style weights, newest epoch first. Most weight on the present so wake onset is seen quickly. */
export const CK_WEIGHTS = [0.5, 0.25, 0.12, 0.08, 0.05] as const;

/**
 * Weighted activity (m/s^2 mean abs deviation) above which the user is judged awake.
 * Calibrated on synthetic nights: sleeping bursts stay well below it, real movement well above.
 */
export const WAKE_THRESHOLD = 0.04;

/** Epoch activity below this counts as motionless; sits just above accelerometer noise on a mattress. */
export const STILL_ACTIVITY = 0.006;

/** 6 epochs (3 min) of stillness before deep sleep is considered; shorter stillness is common in light sleep. */
export const DEEP_STILL_EPOCHS = 6;

/** HR rules stay off until the night has this many HR epochs, otherwise the personal baseline is noise. */
export const BASELINE_MIN_HR_EPOCHS = 20;

/** Deep needs HR no more than this far above the personal 25th percentile (bpm). */
export const DEEP_HR_MARGIN_BPM = 0.5;

/** Deep needs within-epoch HR SD at or below this multiple of the personal median SD. */
export const DEEP_SD_RATIO = 1.0;

/** REM needs within-epoch HR SD at least this multiple of the personal median SD (REM HR is variable). */
export const REM_SD_RATIO = 1.5;

/** Minimum stillness run for REM; REM atonia means near-zero motion. */
export const REM_STILL_EPOCHS = 2;

// --- Smart alarm ---

export const MIN_WINDOW_MS = 20 * 60_000;
/** Beyond 3 h the window stops being a "wake moment" and becomes a lie-in. */
export const MAX_WINDOW_MS = 3 * 60 * 60_000;
export const DEFAULT_WINDOW_MIN = 30;

/** 2 min of consecutive light/wake epochs so a single misclassified epoch cannot fire the alarm. */
export const LIGHT_RUN_EPOCHS = 4;

/** 5 min after deep sleep the sleeper is still groggy (sleep inertia), so do not wake into it. */
export const DEEP_COOLDOWN_EPOCHS = 10;

/** Data older than this many epochs is not trusted for a smart trigger. */
export const FRESH_EPOCHS = 2;

/** Mean confidence the light run must reach; filters out stillness that merely has not yet become deep. */
export const SMART_MIN_CONFIDENCE = 0.45;

// --- Summary ---

/** 10 min of unbroken sleep defines sleep onset (ignores brief dozing while settling). */
export const ONSET_SUSTAINED_EPOCHS = 20;
/** Wake runs shorter than 1 min are sensor flicker, not an awakening. */
export const MIN_AWAKENING_EPOCHS = 2;
/** REM runs shorter than 2 min do not count as a REM period when measuring cycle length. */
export const MIN_REM_BLOCK_EPOCHS = 4;
/** REM runs separated by less than 5 min of non-deep sleep belong to the same period. */
export const REM_BLOCK_MERGE_EPOCHS = 10;
/** Quality weights; sum to 1. */
export const QUALITY_WEIGHTS = { duration: 0.35, efficiency: 0.25, restorative: 0.2, latency: 0.1, continuity: 0.1 } as const;
export const QUALITY_TARGET_SLEEP_MIN = 450;
export const QUALITY_TARGET_RESTORATIVE_SHARE = 0.4;

// --- Suggestions ---

export const DEFAULT_CYCLE_MIN = 90;
export const MIN_CYCLE_MIN = 70;
export const MAX_CYCLE_MIN = 120;
export const DEFAULT_LATENCY_MIN = 15;
