// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.engine

import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.BASELINE_MIN_HR_EPOCHS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.CK_WEIGHTS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.DEEP_HR_MARGIN_BPM
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.DEEP_SD_RATIO
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.DEEP_STILL_EPOCHS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.REM_SD_RATIO
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.REM_STILL_EPOCHS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.STILL_ACTIVITY
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.STILL_ACTIVITY_WATCH
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.WAKE_THRESHOLD
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.WAKE_THRESHOLD_WATCH
import kotlin.math.max
import kotlin.math.min

fun interface EpochStager {
    fun process(e: Epoch): EpochResult
}

/** Sorted-list percentile helper; a night is at most ~1000 epochs so insertion cost is irrelevant. */
private class RunningQuantiles {
    private val v = ArrayList<Double>()

    fun add(x: Double) {
        var lo = 0
        var hi = v.size
        while (lo < hi) {
            val mid = (lo + hi) ushr 1
            if (v[mid] < x) lo = mid + 1 else hi = mid
        }
        v.add(lo, x)
    }

    val count: Int get() = v.size

    fun q(p: Double): Double = v[((v.size - 1) * p).toInt()]
}

/**
 * Causal stage estimator, port of src/engine/stager.ts: epoch i's label depends only on epochs <= i, which is
 * also what lets a restarted process rebuild its state by replaying the persisted epochs.
 */
class Stager : EpochStager {
    private val activity = ArrayDeque<Double>()
    private var stillRun = 0
    private val hrMeans = RunningQuantiles()
    private val hrSds = RunningQuantiles()

    override fun process(e: Epoch): EpochResult {
        // NaN enters the window on purpose (weightedActivity skips it), exactly as in JavaScript.
        activity.addFirst(e.activity)
        if (activity.size > CK_WEIGHTS.size) activity.removeLast()

        if (!e.activity.isFinite()) {
            // No motion data means no basis for a label; do not guess from HR alone.
            stillRun = 0
            return EpochResult(e.start, Stage.UNKNOWN, 0.0)
        }

        val hrMean = e.hrMean
        val hrSd = e.hrSd
        if (hrMean != null && hrSd != null) {
            hrMeans.add(hrMean)
            hrSds.add(hrSd)
        }

        val weighted = weightedActivity()
        // Wrist and mattress move differently, so each source has its own thresholds (equal until wrist data exists).
        val watch = e.source == EpochSource.WATCH
        val wakeThreshold = if (watch) WAKE_THRESHOLD_WATCH else WAKE_THRESHOLD
        val still = e.activity < (if (watch) STILL_ACTIVITY_WATCH else STILL_ACTIVITY)
        stillRun = if (still) stillRun + 1 else 0

        if (weighted >= wakeThreshold) {
            return EpochResult(e.start, Stage.WAKE, clamp01(0.55 + 0.45 * min(1.0, weighted / (4 * wakeThreshold))))
        }

        if (hrMean == null || hrSd == null || hrMeans.count < BASELINE_MIN_HR_EPOCHS) return motionOnly(e)

        val medMean = hrMeans.q(0.5)
        val p25Mean = hrMeans.q(0.25)
        val medSd = hrSds.q(0.5)

        if (stillRun >= DEEP_STILL_EPOCHS && hrMean <= p25Mean + DEEP_HR_MARGIN_BPM && hrSd <= medSd * DEEP_SD_RATIO) {
            return EpochResult(e.start, Stage.DEEP, 0.8)
        }
        if (stillRun >= REM_STILL_EPOCHS && hrSd >= medSd * REM_SD_RATIO && hrMean >= medMean) {
            return EpochResult(e.start, Stage.REM, 0.65)
        }
        // Moving, or still without matching HR evidence: light. Movement is the strongest light cue.
        return EpochResult(e.start, Stage.LIGHT, if (still) 0.6 else 0.8)
    }

    private fun motionOnly(e: Epoch): EpochResult {
        if (stillRun >= DEEP_STILL_EPOCHS) {
            // Without HR, long REM atonia looks identical to deep sleep, so this label is weak.
            return EpochResult(e.start, Stage.DEEP, 0.4)
        }
        val confidence = if (stillRun == 0) 0.7 else max(0.15, 0.7 - 0.1 * stillRun)
        return EpochResult(e.start, Stage.LIGHT, confidence)
    }

    private fun weightedActivity(): Double {
        var num = 0.0
        var den = 0.0
        for (i in activity.indices) {
            val a = activity[i]
            if (!a.isFinite()) continue
            val w = CK_WEIGHTS[i]
            num += w * a
            den += w
        }
        // Renormalise so gap epochs shrink the window instead of biasing toward "asleep".
        return if (den > 0) num / den else 0.0
    }

    private fun clamp01(x: Double) = max(0.0, min(1.0, x))
}
