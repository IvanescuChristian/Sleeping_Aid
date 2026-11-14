// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import android.content.Context
import io.github.ivanescuchristian.sleepingaid.engine.AlarmDecision
import io.github.ivanescuchristian.sleepingaid.engine.AlarmReason
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig
import io.github.ivanescuchristian.sleepingaid.engine.MotionSample
import io.github.ivanescuchristian.sleepingaid.engine.MotionSource
import io.github.ivanescuchristian.sleepingaid.engine.Pipeline
import io.github.ivanescuchristian.sleepingaid.engine.Stage
import io.github.ivanescuchristian.sleepingaid.engine.WatchBatch
import io.github.ivanescuchristian.sleepingaid.engine.WatchFeed

/**
 * Process-wide host of the native sleep engine for the night being tracked. NightService feeds it phone
 * motion, WatchMessageService feeds it watch batches, both from their own threads, so every entry point is
 * synchronized. All decisions go through [handle]: the decision is persisted FIRST, then the alarm is rung.
 */
object NightTracker {
    private val lock = Any()
    private var pipe: Pipeline? = null
    private var night: NightStore.Night? = null

    private var lastActivityAt = 0L
    private var lastHrBpm = 0.0
    private var lastHrAt = 0L
    private var lastTickAt = 0L
    private var watchStartResends = 0

    /** Phone sensor rate over the last ~5 s, written by NightService for the status shown in the app. */
    @Volatile
    var motionHz = 0

    /** Resend times after the start of the night when the watch has said nothing (Data Layer is best effort). */
    private val RESEND_START_AT_MS = longArrayOf(45_000, 120_000)

    fun isActive(): Boolean = synchronized(lock) { pipe != null }

    /** Builds the pipeline for [n] and replays persisted epochs, so a restarted process continues where it was. */
    fun start(ctx: Context, n: NightStore.Night, now: Long = System.currentTimeMillis()) = synchronized(lock) {
        val app = ctx.applicationContext
        val p = Pipeline(n.windowStart, n.windowEnd, onEpoch = { e, r -> NightStore.appendEpoch(app, e, r) })
        p.restore(NightStore.readEpochs(app).map { it.epoch })
        pipe = p
        night = n
        lastActivityAt = 0L
        lastHrAt = 0L
        lastTickAt = now
        watchStartResends = 0
    }

    fun stop() = synchronized(lock) {
        pipe = null
        night = null
    }

    /** Which sensor feeds motion now. Both must never run together: they add to the same epoch accumulator. */
    fun motionSource(now: Long): MotionSource? = synchronized(lock) {
        val n = night ?: return null
        if (!n.useWatch) return MotionSource.PHONE
        WatchFeed.chooseMotionSource(now, n.startedAt, lastActivityAt)
    }

    /** One phone accelerometer sample (event time [t], phone clock). Returns true when the night is over. */
    fun onPhoneMotion(ctx: Context, t: Long, ax: Double, ay: Double, az: Double, now: Long): Boolean = synchronized(lock) {
        val p = pipe ?: return true
        val n = night ?: return true
        if (n.useMotion && (!n.useWatch || WatchFeed.chooseMotionSource(now, n.startedAt, lastActivityAt) == MotionSource.PHONE)) {
            p.ingestMotion(MotionSample(t, ax, ay, az))
        }
        // Once a second at most: the engine only needs a tick per epoch, and a tick is cheap but not free.
        if (now - lastTickAt >= 1_000) tickLocked(ctx, p, n, now) else false
    }

    /** A batch from the watch (already deduplicated). Returns true when the night is over. */
    fun onWatchBatch(ctx: Context, b: WatchBatch, now: Long): Boolean = synchronized(lock) {
        val p = pipe ?: return false
        val n = night ?: return false
        if (!n.useWatch) return false
        if (WatchFeed.apply(p, b, notBefore = n.startedAt - 60_000)) lastActivityAt = now
        b.hr.lastOrNull()?.let {
            lastHrBpm = it.bpm
            lastHrAt = now
        }
        tickLocked(ctx, p, n, now)
    }

    /** Periodic tick (also driven by sensor and watch events). Returns true when the night is over. */
    fun tick(ctx: Context, now: Long): Boolean = synchronized(lock) {
        val p = pipe ?: return true
        val n = night ?: return true
        tickLocked(ctx, p, n, now)
    }

    private fun tickLocked(ctx: Context, p: Pipeline, n: NightStore.Night, now: Long): Boolean {
        lastTickAt = now
        resendWatchStart(ctx, n, now)
        // Phone samples arrive in batches, so epochs may only be closed by the clock once the batch that holds
        // their last samples must have been delivered. The window rules still use the real clock.
        // Also with the watch live: phone motion is the fallback source, and the 60 s watch shift leaves ample freshness.
        val lag = if (n.useMotion) EngineConfig.SENSOR_ADVANCE_LAG_MS else 0L
        val d = p.tick(now, now - lag) ?: return p.alarm.decision != null
        handle(ctx, d)
        return true
    }

    private fun resendWatchStart(ctx: Context, n: NightStore.Night, now: Long) {
        if (!n.useWatch || lastActivityAt != 0L) return
        val due = RESEND_START_AT_MS.getOrNull(watchStartResends) ?: return
        if (now - n.startedAt >= due) {
            watchStartResends++
            WatchLink.sendStart(ctx.applicationContext)
        }
    }

    /**
     * The engine decided. Persist before ringing (a kill in between must not lose the outcome), keep the CPU up
     * until the alarm service has taken over, then ring through the same path as the backup alarm.
     *
     * A smart decision rings now. A fallback decision (the window ended) is recorded only: the exact AlarmManager
     * alarm rings it, and ringing twice is exactly what the FIRED state in AlarmStore prevents anyway.
     */
    private fun handle(ctx: Context, d: AlarmDecision) {
        val app = ctx.applicationContext
        val recorded = NightStore.recordWake(app, d.reason.wire, d.at, d.stageAtTrigger)
        if (recorded && d.reason == AlarmReason.SMART) {
            HardAlarm.holdBriefly(app)
            HardAlarm.fireNow(app)
        }
    }

    /** The backup alarm rang while the engine had not decided (or the process was dead): record that reason. */
    fun onBackupRang(ctx: Context, now: Long) {
        val app = ctx.applicationContext
        val stage = synchronized(lock) { pipe?.alarm?.lastStage } ?: NightStore.readEpochs(app).lastOrNull()?.result?.stage ?: Stage.UNKNOWN
        NightStore.recordWake(app, AlarmReason.FALLBACK.wire, now, stage)
    }

    class Snapshot(
        val stage: String,
        val epochs: Int,
        val lastEpochAt: Long,
        val motionSource: String,
        val hrBpm: Double?,
        val errors: Int,
        val engineRunning: Boolean,
    )

    fun snapshot(ctx: Context, now: Long): Snapshot = synchronized(lock) {
        val p = pipe
        val n = night ?: NightStore.load(ctx.applicationContext)
        val hr = if (lastHrAt > 0 && now - lastHrAt < 150_000) lastHrBpm else null
        if (p != null && n != null) {
            val src = when {
                n.useWatch && WatchFeed.chooseMotionSource(now, n.startedAt, lastActivityAt) == MotionSource.WATCH -> if (lastActivityAt > 0) "watch" else "watch-waiting"
                n.useMotion -> "phone"
                else -> "none"
            }
            Snapshot(p.alarm.lastStage.wire, p.results.size, p.alarm.lastEpochStart ?: 0L, src, hr, p.pipelineErrors, true)
        } else {
            val last = NightStore.readEpochs(ctx.applicationContext)
            Snapshot(last.lastOrNull()?.result?.stage?.wire ?: Stage.UNKNOWN.wire, last.size, last.lastOrNull()?.epoch?.start ?: 0L, "none", null, 0, false)
        }
    }
}
