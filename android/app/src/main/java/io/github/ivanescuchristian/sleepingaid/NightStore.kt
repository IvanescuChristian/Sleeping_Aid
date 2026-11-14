// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import android.content.Context
import io.github.ivanescuchristian.sleepingaid.engine.Epoch
import io.github.ivanescuchristian.sleepingaid.engine.EpochResult
import io.github.ivanescuchristian.sleepingaid.engine.EpochSource
import io.github.ivanescuchristian.sleepingaid.engine.Stage
import java.io.File

/**
 * The running night, persisted so the native engine survives process death and reboot, and so JavaScript can
 * read the outcome when it wakes up late.
 *
 * Two things live here: the night's parameters and outcome (preferences) and one line per closed epoch (a small
 * file, about 100 KB for a night). An epoch line keeps the aggregated INPUT of the stager as well as its label:
 * the stager is causal, so replaying the inputs rebuilds its exact state (heart-rate baseline, stillness run)
 * after a restart, which a bare list of labels could not do.
 *
 * Everything is in device-protected storage, like AlarmStore, so a restart before the first unlock after a
 * reboot can still read it. No raw sensor data is ever written.
 */
object NightStore {
    enum class State {
        /** The engine owns the night and the service should be running. */
        TRACKING,

        /** A wake decision (smart or backup) was made; the alarm took over. */
        WOKE,

        /** Stopped by the user or expired. */
        ENDED,
    }

    data class Night(
        val startedAt: Long,
        val windowStart: Long,
        val windowEnd: Long,
        val useMotion: Boolean,
        val useWatch: Boolean,
        val state: State,
        /** "smart" or "fallback" once the state is WOKE. */
        val wakeReason: String?,
        val wakeAt: Long,
        val wakeStage: String?,
    )

    private const val PREFS = "sleepaid_night"
    private const val EPOCH_FILE = "night_epochs.csv"
    private const val MAX_EPOCH_LINES = 3_000

    private val lock = Any()

    private fun dp(ctx: Context): Context = ctx.createDeviceProtectedStorageContext()
    private fun prefs(ctx: Context) = dp(ctx).getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun file(ctx: Context) = File(dp(ctx).filesDir, EPOCH_FILE)

    fun load(ctx: Context): Night? = synchronized(lock) {
        val p = prefs(ctx)
        if (!p.contains("startedAt")) return null
        val state = runCatching { State.valueOf(p.getString("state", "") ?: "") }.getOrNull() ?: return null
        Night(
            startedAt = p.getLong("startedAt", 0L),
            windowStart = p.getLong("windowStart", 0L),
            windowEnd = p.getLong("windowEnd", 0L),
            useMotion = p.getBoolean("useMotion", true),
            useWatch = p.getBoolean("useWatch", false),
            state = state,
            wakeReason = p.getString("wakeReason", null),
            wakeAt = p.getLong("wakeAt", 0L),
            wakeStage = p.getString("wakeStage", null),
        )
    }

    /** Starts a fresh night: forgets the previous outcome and epochs. */
    fun begin(ctx: Context, n: Night) = synchronized(lock) {
        file(ctx).delete()
        // commit(): the process may be killed right after; the night must already be on disk.
        prefs(ctx).edit().clear()
            .putLong("startedAt", n.startedAt).putLong("windowStart", n.windowStart).putLong("windowEnd", n.windowEnd)
            .putBoolean("useMotion", n.useMotion).putBoolean("useWatch", n.useWatch)
            .putString("state", State.TRACKING.name).commit()
        Unit
    }

    /**
     * Records the wake decision. Only the first one counts, and only for a night still being tracked, so a late
     * "backup rang" notice cannot overwrite a smart wake. Returns whether this call recorded it.
     */
    fun recordWake(ctx: Context, reason: String, at: Long, stage: Stage): Boolean = synchronized(lock) {
        val n = load(ctx) ?: return false
        if (n.state != State.TRACKING) return false
        prefs(ctx).edit().putString("state", State.WOKE.name).putString("wakeReason", reason)
            .putLong("wakeAt", at).putString("wakeStage", stage.wire).commit()
    }

    fun markEnded(ctx: Context) = synchronized(lock) {
        val n = load(ctx) ?: return@synchronized
        if (n.state == State.TRACKING) prefs(ctx).edit().putString("state", State.ENDED.name).commit()
    }

    fun clear(ctx: Context) = synchronized(lock) {
        file(ctx).delete()
        prefs(ctx).edit().clear().commit()
        Unit
    }

    // ---------- Epochs ----------

    /**
     * One CSV line: start,stage,confidence,activity,hrMean,hrSd,motionSamples,hrSamples,source (watch, phone or
     * empty). Doubles round-trip exactly. Lines of 0.1.0 have no source column and are still read.
     */
    fun appendEpoch(ctx: Context, e: Epoch, r: EpochResult) = synchronized(lock) {
        val f = file(ctx)
        f.appendText(format(e, r) + "\n")
        // A night is about 1000 epochs; this only guards against a clock bug writing forever.
        if (f.length() > MAX_EPOCH_LINES * 100L) {
            val lines = f.readLines()
            f.writeText(lines.drop(lines.size / 2).joinToString("\n", postfix = "\n"))
        }
    }

    internal fun format(e: Epoch, r: EpochResult): String =
        "${e.start},${r.stage.wire},${r.confidence},${e.activity},${e.hrMean ?: ""},${e.hrSd ?: ""},${e.motionSamples},${e.hrSamples},${e.source?.wire ?: ""}"

    data class Stored(val epoch: Epoch, val result: EpochResult)

    fun readEpochs(ctx: Context): List<Stored> = synchronized(lock) {
        val f = file(ctx)
        if (!f.exists()) return emptyList()
        f.readLines().mapNotNull { parse(it) }
    }

    internal fun parse(line: String): Stored? {
        val c = line.split(',')
        if (c.size != 8 && c.size != 9) return null
        return try {
            val start = c[0].toLong()
            val stage = Stage.fromWire(c[1]) ?: return null
            val epoch = Epoch(start, c[3].toDouble(), c[4].toDoubleOrNull(), c[5].toDoubleOrNull(), c[6].toInt(), c[7].toInt(), c.getOrNull(8)?.let { EpochSource.fromWire(it) })
            Stored(epoch, EpochResult(start, stage, c[2].toDouble()))
        } catch (_: NumberFormatException) {
            null
        }
    }
}
