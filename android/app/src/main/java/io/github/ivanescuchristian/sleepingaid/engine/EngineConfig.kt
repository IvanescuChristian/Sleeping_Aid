// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.engine

/**
 * Every tunable of the native sleep-stage engine, in one place.
 *
 * WHY a mirror: the JavaScript engine (src/engine/config.ts) stays the reference and still runs on the web.
 * The native engine must make the same decisions, so these values are copied one to one. The parity
 * fixtures (tests/fixtures/engine-parity, checked by the Kotlin and the Vitest suites) fail if either side
 * drifts; when you retune a value, change src/engine/config.ts here and regenerate the fixtures
 * (npm run fixtures:engine).
 */
object EngineConfig {
    /** src/engine/config.ts EPOCH_MS: the standard 30 s actigraphy epoch. */
    const val EPOCH_MS = 30_000L

    /** REORDER_GRACE_MS: a late packet from the other sensor must still land in its epoch. */
    const val REORDER_GRACE_MS = 2_000L

    /** GRAVITY_TAU_MS: gravity high-pass time constant. */
    const val GRAVITY_TAU_MS = 4_000.0

    /** MAX_GAP_EPOCHS: bound on gap epochs emitted by one jump, so a bogus timestamp cannot spin the loop. */
    const val MAX_GAP_EPOCHS = 2_880

    /** MIN_HR_SAMPLES_FOR_SD */
    const val MIN_HR_SAMPLES_FOR_SD = 5

    /** CK_WEIGHTS: causal Cole-Kripke-style weights, newest epoch first. */
    val CK_WEIGHTS = doubleArrayOf(0.5, 0.25, 0.12, 0.08, 0.05)

    const val WAKE_THRESHOLD = 0.04
    const val STILL_ACTIVITY = 0.006
    const val DEEP_STILL_EPOCHS = 6
    const val BASELINE_MIN_HR_EPOCHS = 20
    const val DEEP_HR_MARGIN_BPM = 0.5
    const val DEEP_SD_RATIO = 1.0
    const val REM_SD_RATIO = 1.5
    const val REM_STILL_EPOCHS = 2

    // --- Smart alarm ---
    const val MIN_WINDOW_MS = 20 * 60_000L
    const val MAX_WINDOW_MS = 3 * 60 * 60_000L
    const val LIGHT_RUN_EPOCHS = 4
    const val DEEP_COOLDOWN_EPOCHS = 10
    const val FRESH_EPOCHS = 2
    const val SMART_MIN_CONFIDENCE = 0.45

    // --- Watch as a source (src/native/watch.ts) ---

    /**
     * WATCH_SHIFT_MS: watch epochs reach the phone after they ended, so each timestamp moves this much later
     * (a multiple of the epoch length) to land in an epoch the aggregator has not closed yet. Kept identical
     * to JavaScript so the native engine sees the same timeline and the same data freshness.
     */
    const val WATCH_SHIFT_MS = 2 * EPOCH_MS

    /** WATCH_FRESH_MS: the watch is the live motion source while its last activity epoch is younger than this. */
    const val WATCH_FRESH_MS = 150_000L

    /** WATCH_GRACE_MS: after a night starts the watch gets this long to deliver before the phone sensor takes over. */
    const val WATCH_GRACE_MS = 240_000L

    // --- Native runtime only (no JavaScript counterpart, not part of the parity check) ---

    /** Longest time the accelerometer may hold events before delivering them (sensor batching). */
    const val SENSOR_MAX_LATENCY_MS = 20_000L

    /**
     * The aggregator may only be advanced by the clock to now minus this. A batch delivered at time W holds samples
     * up to W, so at W+5 s the next ones are still in the sensor FIFO; closing epochs up to "now" would emit
     * them without those samples and drop them as late. Latency plus the reorder grace plus margin. Cost: a smart
     * decision, or a gap epoch, can lag by up to this much.
     */
    const val SENSOR_ADVANCE_LAG_MS = SENSOR_MAX_LATENCY_MS + REORDER_GRACE_MS + 3_000L
}
