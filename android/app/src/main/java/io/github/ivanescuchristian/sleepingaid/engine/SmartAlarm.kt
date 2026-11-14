// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.engine

import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.DEEP_COOLDOWN_EPOCHS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.EPOCH_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.FRESH_EPOCHS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.LIGHT_RUN_EPOCHS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.MAX_WINDOW_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.MIN_WINDOW_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.SMART_MIN_CONFIDENCE

enum class AlarmWindowError { END_NOT_AFTER_START, TOO_SHORT, TOO_LONG }

class AlarmWindowException(val code: AlarmWindowError, message: String) : IllegalArgumentException(message)

fun validateWindow(windowStart: Long, windowEnd: Long) {
    if (windowEnd <= windowStart) throw AlarmWindowException(AlarmWindowError.END_NOT_AFTER_START, "Wake window end must be after its start")
    val len = windowEnd - windowStart
    if (len < MIN_WINDOW_MS) throw AlarmWindowException(AlarmWindowError.TOO_SHORT, "Wake window must be at least ${MIN_WINDOW_MS / 60_000} minutes")
    if (len > MAX_WINDOW_MS) throw AlarmWindowException(AlarmWindowError.TOO_LONG, "Wake window must be at most ${MAX_WINDOW_MS / 60_000} minutes")
}

/**
 * Smart-wake decision, port of src/engine/smartAlarm.ts. A decision is returned at most once. The fallback
 * branch reads only the window bounds and the clock value passed in, so no stager state can block it.
 */
class SmartAlarm(val windowStart: Long, val windowEnd: Long) {
    private val recent = ArrayList<EpochResult>()

    var decision: AlarmDecision? = null
        private set
    var lastStage: Stage = Stage.UNKNOWN
        private set
    var lastEpochStart: Long? = null
        private set
    var epochsIngested = 0
        private set

    init {
        validateWindow(windowStart, windowEnd)
    }

    /** Feeds one stager result. Ignored once a decision exists. */
    fun ingest(r: EpochResult): Boolean {
        if (decision != null) return false
        if (!r.confidence.isFinite()) return false
        recent.add(r)
        val keep = maxOf(DEEP_COOLDOWN_EPOCHS, LIGHT_RUN_EPOCHS)
        if (recent.size > keep) recent.removeAt(0)
        lastStage = r.stage
        lastEpochStart = r.start
        epochsIngested++
        return true
    }

    fun tick(now: Long): AlarmDecision? {
        if (decision != null) return null
        if (now >= windowEnd) return fire(AlarmDecision(AlarmReason.FALLBACK, now, lastStage))
        if (now >= windowStart && smartConditionsMet(now)) return fire(AlarmDecision(AlarmReason.SMART, now, lastStage))
        return null
    }

    private fun fire(d: AlarmDecision): AlarmDecision {
        decision = d
        return d
    }

    private fun smartConditionsMet(now: Long): Boolean {
        val last = recent.lastOrNull() ?: return false
        if (now - (last.start + EPOCH_MS) >= FRESH_EPOCHS * EPOCH_MS) return false

        if (recent.size < LIGHT_RUN_EPOCHS) return false
        val run = recent.subList(recent.size - LIGHT_RUN_EPOCHS, recent.size)
        // Wake counts as good: someone already awake gains nothing from waiting.
        if (!run.all { it.stage == Stage.LIGHT || it.stage == Stage.WAKE }) return false
        if (recent.takeLast(DEEP_COOLDOWN_EPOCHS).any { it.stage == Stage.DEEP }) return false
        val meanConf = run.sumOf { it.confidence } / run.size
        return meanConf >= SMART_MIN_CONFIDENCE
    }
}
