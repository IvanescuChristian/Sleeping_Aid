// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.engine

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Buckets samples into fixed epochs. Port of src/engine/epochs.ts: motion and HR may arrive in any
 * interleaving, and an epoch only closes once time has passed its end plus a small grace.
 */
class EpochAggregator(private val epochMs: Long = EngineConfig.EPOCH_MS) {
    private class Acc {
        var devSum = 0.0
        var motionN = 0
        var hrN = 0
        var hrMean = 0.0
        var hrM2 = 0.0
    }

    private val open = HashMap<Long, Acc>()
    private var nextEmit: Long? = null
    private var maxT = Long.MIN_VALUE
    private var gravity: Double? = null
    private var lastMotionT = Long.MIN_VALUE

    /** Samples dropped for non-finite fields. */
    var rejected = 0
        private set

    /** Samples dropped because their epoch had already been emitted. */
    var late = 0
        private set

    fun ingestMotion(s: MotionSample): List<Epoch> {
        if (!s.ax.isFinite() || !s.ay.isFinite() || !s.az.isFinite()) {
            rejected++
            return emptyList()
        }
        val start = bucket(s.t)
        if (isClosed(start)) {
            late++
            return emptyList()
        }
        // Magnitude, not axes: the phone can lie in any orientation on the mattress.
        val mag = hypot(hypot(s.ax, s.ay), s.az)
        var dev = 0.0
        val g = gravity
        if (g == null) {
            gravity = mag
        } else {
            dev = abs(mag - g)
            val dt = max(0.0, (s.t - lastMotionT).toDouble())
            gravity = g + (1 - exp(-dt / EngineConfig.GRAVITY_TAU_MS)) * (mag - g)
        }
        lastMotionT = max(lastMotionT, s.t)
        val acc = acc(start)
        acc.devSum += dev
        acc.motionN++
        return touch(s.t)
    }

    /** Adds activity aggregated elsewhere (the watch). A source must not mix this with raw motion for the same epochs. */
    fun ingestActivity(a: ActivitySample): List<Epoch> {
        if (!a.activity.isFinite() || a.activity < 0 || a.samples < 1) {
            rejected++
            return emptyList()
        }
        val start = bucket(a.t)
        if (isClosed(start)) {
            late++
            return emptyList()
        }
        val acc = acc(start)
        acc.devSum += a.activity * a.samples
        acc.motionN += a.samples
        return touch(a.t)
    }

    fun ingestHr(s: HrSample): List<Epoch> {
        if (!s.bpm.isFinite() || s.bpm <= 0) {
            rejected++
            return emptyList()
        }
        val start = bucket(s.t)
        if (isClosed(start)) {
            late++
            return emptyList()
        }
        val acc = acc(start)
        acc.hrN++
        val d = s.bpm - acc.hrMean
        acc.hrMean += d / acc.hrN
        acc.hrM2 += d * (s.bpm - acc.hrMean)
        return touch(s.t)
    }

    /** Advances time without a sample, so sensor gaps still close (and are reported) on schedule. */
    fun advance(nowMs: Long): List<Epoch> = touch(nowMs)

    /**
     * Continues after a process restart: every epoch before [nextEmitMs] was already emitted and persisted.
     * Not in the JavaScript engine (a web page reload loses its history); the sample-level state (open epochs,
     * gravity estimate) restarts empty, which at worst turns one epoch into a gap epoch.
     */
    fun resumeAt(nextEmitMs: Long) {
        nextEmit = nextEmitMs
        open.clear()
    }

    private fun touch(t: Long): List<Epoch> {
        if (t > maxT) maxT = t
        return drain(maxT)
    }

    // floorDiv, not "/": Kotlin truncates toward zero, JavaScript's Math.floor rounds down.
    private fun bucket(t: Long): Long = Math.floorDiv(t, epochMs) * epochMs

    private fun isClosed(start: Long): Boolean = nextEmit?.let { start < it } ?: false

    private fun acc(start: Long): Acc {
        if (nextEmit == null) nextEmit = start
        return open.getOrPut(start) { Acc() }
    }

    private fun drain(upTo: Long): List<Epoch> {
        val out = ArrayList<Epoch>()
        var next = nextEmit ?: return out
        val lastClosable = bucket(upTo - EngineConfig.REORDER_GRACE_MS) - epochMs
        if ((lastClosable - next) / epochMs > EngineConfig.MAX_GAP_EPOCHS) {
            next = lastClosable - EngineConfig.MAX_GAP_EPOCHS * epochMs
            open.clear()
        }
        while (next <= lastClosable) {
            out.add(emit(next))
            open.remove(next)
            next += epochMs
        }
        nextEmit = next
        return out
    }

    private fun emit(start: Long): Epoch {
        val a = open[start] ?: return Epoch(start, Double.NaN, null, null, 0, 0)
        return Epoch(
            start = start,
            activity = if (a.motionN > 0) a.devSum / a.motionN else Double.NaN,
            hrMean = if (a.hrN > 0) a.hrMean else null,
            hrSd = if (a.hrN >= EngineConfig.MIN_HR_SAMPLES_FOR_SD) sqrt(a.hrM2 / a.hrN) else null,
            motionSamples = a.motionN,
            hrSamples = a.hrN,
        )
    }
}
