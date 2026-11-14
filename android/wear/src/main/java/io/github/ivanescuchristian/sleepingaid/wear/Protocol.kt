// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.wear

import java.util.Locale
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Wire contract between the watch and the phone app. Plain Kotlin on purpose (no Android classes), so it
 * can be read and checked on its own; the phone-side decoder is src/native/watch.ts and its contract is
 * pinned by tests/fixtures/watch-batch.json.
 *
 * Batch (UTF-8 JSON, schema v1), path /sleepaid/epochs:
 *   {"v":1,"session":"<id>","seq":7,"sentAt":<ms>,"epochMs":30000,
 *    "epochs":[{"t":<epoch start ms>,"act":<mean abs deviation, m/s^2>,"n":<accelerometer samples>}],
 *    "hr":[[<ms>,<bpm>]]}
 * All times are wall-clock epoch milliseconds. "session" is random per tracking run and "seq" counts from 1
 * inside it, so (session, seq) identifies a batch; the phone drops repeats. A batch only contains heart-rate
 * samples that are older than the end of the last epoch it carries (see BatchBuilder.build).
 */
object Protocol {
    const val SCHEMA = 1
    const val PATH_EPOCHS = "/sleepaid/epochs"
    const val PATH_START = "/sleepaid/start"
    const val PATH_STOP = "/sleepaid/stop"

    /** Capability the phone app advertises (phone res/values/wear.xml). */
    const val CAP_PHONE = "sleepaid_phone"

    /** Capability this watch app advertises (wear res/values/wear.xml). */
    const val CAP_WATCH = "sleepaid_watch"

    /** Same epoch length as the phone stager (src/engine/config.ts EPOCH_MS). */
    const val EPOCH_MS = 30_000L

    /** Gravity high-pass time constant, same as the phone (GRAVITY_TAU_MS). */
    const val GRAVITY_TAU_MS = 4_000.0

    /** A tracking run stops by itself after this long. */
    const val MAX_RUN_MS = 14 * 60 * 60_000L
}

data class ActivityEpoch(val start: Long, val activity: Double, val samples: Int)

data class HrPoint(val t: Long, val bpm: Double)

/**
 * Per-epoch wrist activity, computed exactly like the phone's EpochAggregator: the magnitude of the
 * acceleration, high-passed against a gravity estimate with a 4 s time constant, averaged as an absolute
 * deviation per 30 s epoch. An epoch is closed when a sample of a later epoch arrives, so the result depends
 * only on sample timestamps (never on when the batch was delivered).
 */
class ActivityAccumulator(
    private val epochMs: Long = Protocol.EPOCH_MS,
    private val tauMs: Double = Protocol.GRAVITY_TAU_MS,
) {
    private var gravity: Double? = null
    private var lastT = Long.MIN_VALUE
    private var curStart = Long.MIN_VALUE
    private var devSum = 0.0
    private var n = 0
    private val closed = ArrayList<ActivityEpoch>()

    /** End of the latest closed epoch; 0 before the first one closes. */
    var lastClosedEnd = 0L
        private set

    /** Samples older than the open epoch (should not happen with a time-ordered sensor stream). */
    var outOfOrder = 0L
        private set

    fun add(t: Long, ax: Double, ay: Double, az: Double) {
        val mag = sqrt(ax * ax + ay * ay + az * az)
        if (!mag.isFinite()) return
        val bucket = Math.floorDiv(t, epochMs) * epochMs
        if (curStart == Long.MIN_VALUE) curStart = bucket
        if (bucket < curStart) {
            outOfOrder++
            return
        }
        if (bucket > curStart) {
            closeCurrent()
            curStart = bucket
        }
        var dev = 0.0
        val g = gravity
        if (g == null) {
            gravity = mag
        } else {
            dev = abs(mag - g)
            val dt = max(0L, t - lastT).toDouble()
            gravity = g + (1.0 - exp(-dt / tauMs)) * (mag - g)
        }
        lastT = max(lastT, t)
        devSum += dev
        n++
    }

    private fun closeCurrent() {
        if (n > 0) closed.add(ActivityEpoch(curStart, devSum / n, n))
        lastClosedEnd = curStart + epochMs
        devSum = 0.0
        n = 0
    }

    val hasClosed: Boolean get() = closed.isNotEmpty()

    /** Returns and forgets the epochs closed since the last call. */
    fun takeClosed(): List<ActivityEpoch> {
        val out = ArrayList(closed)
        closed.clear()
        return out
    }
}

/** Collects heart-rate samples and turns closed epochs plus covered heart rate into numbered batches. */
class BatchBuilder(val session: String) {
    private var seq = 0L
    private val hr = ArrayList<HrPoint>()

    val bufferedHr: Int get() = hr.size

    fun addHr(t: Long, bpm: Double) {
        hr.add(HrPoint(t, bpm))
        if (hr.size > MAX_BUFFERED_HR) hr.removeAt(0)
    }

    /**
     * Builds the next batch from [epochs] and the buffered heart rate older than [coveredUntil], or null when
     * there is nothing to send. [coveredUntil] is the end of the last closed epoch while the accelerometer is
     * alive: the phone closes an epoch as soon as it sees data past the epoch end, so heart rate beyond it must
     * not travel before that epoch's activity does.
     */
    fun build(epochs: List<ActivityEpoch>, coveredUntil: Long, sentAt: Long): Pair<Long, String>? {
        val send = hr.filter { it.t < coveredUntil }.sortedBy { it.t }
        if (epochs.isEmpty() && send.isEmpty()) return null
        hr.removeAll { it.t < coveredUntil }
        seq++
        return seq to encode(session, seq, sentAt, epochs, send)
    }

    companion object {
        private const val MAX_BUFFERED_HR = 5_000

        fun encode(session: String, seq: Long, sentAt: Long, epochs: List<ActivityEpoch>, hr: List<HrPoint>): String {
            val sb = StringBuilder(128 + epochs.size * 48 + hr.size * 24)
            sb.append("{\"v\":").append(Protocol.SCHEMA)
            sb.append(",\"session\":\"").append(session).append('"')
            sb.append(",\"seq\":").append(seq)
            sb.append(",\"sentAt\":").append(sentAt)
            sb.append(",\"epochMs\":").append(Protocol.EPOCH_MS)
            sb.append(",\"epochs\":[")
            epochs.forEachIndexed { i, e ->
                if (i > 0) sb.append(',')
                sb.append("{\"t\":").append(e.start)
                sb.append(",\"act\":").append(String.format(Locale.ROOT, "%.6f", e.activity))
                sb.append(",\"n\":").append(e.samples).append('}')
            }
            sb.append("],\"hr\":[")
            hr.forEachIndexed { i, p ->
                if (i > 0) sb.append(',')
                sb.append('[').append(p.t).append(',').append(String.format(Locale.ROOT, "%.1f", p.bpm)).append(']')
            }
            sb.append("]}")
            return sb.toString()
        }
    }
}
