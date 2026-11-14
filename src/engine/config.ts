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

/**
 * Wrist counterparts of the two thresholds above. The watch computes its activity with the same formula, gravity
 * filter and unit as the phone (android/wear Protocol.kt ActivityAccumulator), but a wrist moves more than a
 * mattress, so the true wrist values are probably higher. There is no recorded wrist night to calibrate on yet,
 * so they equal the phone values on purpose; the stager already selects them by epoch source, so retuning is
 * a change to these two numbers (then npm run fixtures:engine) and nothing else.
 */
export const WAKE_THRESHOLD_WATCH = 0.04;
export const STILL_ACTIVITY_WATCH = 0.006;

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

// --- Motion source (watch first, phone as fallback) ---

/**
 * Watch epochs reach the phone after they ended (the watch closes an epoch with its next sensor event, the sensor
 * hub may hold events ~10 s, Bluetooth adds a moment). The aggregator closes an epoch ~2 s after its end, so
 * unshifted watch data would land in closed epochs and be dropped. Every watch timestamp is therefore moved this
 * much later (a multiple of the epoch length, so boundaries stay aligned) before it enters the pipeline.
 * Costs: hypnogram times are this much late, and a smart decision sees data at least this much older.
 */
export const WATCH_SHIFT_MS = 2 * EPOCH_MS;

/**
 * Staleness timeout: no fresh watch epoch for this long and the phone sensor takes over. The watch sends about
 * every 30 s and its data is shifted 60 s, so a healthy stream shows a fresh epoch at least every ~45 s;
 * 150 s is 5 batch periods, long enough that one or two lost Bluetooth messages (the watch re-sends them) do
 * not flip the source, short enough that a dead watch costs only a few epochs before the phone covers the night.
 */
export const WATCH_FRESH_MS = 150_000;

/** After a night starts the watch gets this long to deliver its first epoch before the phone sensor takes over. */
export const WATCH_GRACE_MS = 240_000;

/**
 * Hysteresis for going back to the watch after it was stale: this many consecutive fresh epochs, delivered over at
 * least WATCH_RECOVER_MS. Fresh means "the aggregator can still accept it", so a reconnect that flushes an hour
 * of buffered backlog does not count. A watch that flaps (up a minute, down a few) never gets back in, so the
 * source cannot change more often than once per recovery plus one staleness timeout (about every 3.5 min).
 */
export const WATCH_RECOVER_EPOCHS = 3;
export const WATCH_RECOVER_MS = 60_000;

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
