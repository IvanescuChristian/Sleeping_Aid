// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.engine

/** Estimated sleep stage (src/engine/types.ts Stage). UNKNOWN marks an epoch with no usable motion data. */
enum class Stage(val wire: String) {
    WAKE("wake"),
    LIGHT("light"),
    DEEP("deep"),
    REM("rem"),
    UNKNOWN("unknown"),
    ;

    companion object {
        fun fromWire(s: String): Stage? = entries.firstOrNull { it.wire == s }
    }
}

/** Device that supplied the motion of an epoch (src/engine/types.ts EpochSource). Null on an epoch without motion. */
enum class EpochSource(val wire: String) {
    WATCH("watch"),
    PHONE("phone"),
    ;

    companion object {
        fun fromWire(s: String): EpochSource? = entries.firstOrNull { it.wire == s }
    }
}

/** Accelerometer reading in m/s^2 including gravity; [t] is epoch milliseconds. */
data class MotionSample(val t: Long, val ax: Double, val ay: Double, val az: Double)

/** Heart-rate reading in beats per minute. */
data class HrSample(val t: Long, val bpm: Double)

/** Activity of one epoch measured by another device (the watch): mean absolute deviation over [samples] readings. */
data class ActivitySample(val t: Long, val activity: Double, val samples: Int)

/** One fixed-length slice of aggregated sensor data. [activity] is NaN when no motion samples arrived. */
data class Epoch(
    val start: Long,
    val activity: Double,
    val hrMean: Double?,
    val hrSd: Double?,
    val motionSamples: Int,
    val hrSamples: Int,
    /** Where the motion came from; one device per epoch, null for a gap. Old persisted epochs have none. */
    val source: EpochSource? = null,
)

/** Stager output for one epoch. [confidence] is 0..1. */
data class EpochResult(val start: Long, val stage: Stage, val confidence: Double)

enum class AlarmReason(val wire: String) { SMART("smart"), FALLBACK("fallback") }

data class AlarmDecision(val reason: AlarmReason, val at: Long, val stageAtTrigger: Stage)
