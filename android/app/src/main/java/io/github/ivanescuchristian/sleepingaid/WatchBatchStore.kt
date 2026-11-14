// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import android.content.Context
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig
import io.github.ivanescuchristian.sleepingaid.engine.HrSample
import io.github.ivanescuchristian.sleepingaid.engine.WatchBatch
import io.github.ivanescuchristian.sleepingaid.engine.WatchEpoch
import org.json.JSONObject

/**
 * Decoding and de-duplication of the batches the watch sends. The native engine consumes them directly (see
 * WatchMessageService); nothing is stored here any more, because the engine persists its own epochs and
 * JavaScript no longer drains raw batches. The schema is the one of src/native/watch.ts decodeWatchBatch,
 * pinned by tests/fixtures/watch-batch.json.
 */
object WatchBatchStore {
    /** Messages are far smaller in practice; this only guards against a malformed sender. */
    private const val MAX_MESSAGE_BYTES = 100_000
    private const val MAX_KEYS = 5_000

    private val lock = Any()
    private val seen = LinkedHashSet<String>()

    @Volatile
    var lastReceivedAt = 0L
        private set

    @Volatile
    var lastSession: String? = null
        private set

    @Volatile
    var lastSeq = 0L
        private set

    /** Decodes one batch; null for anything that is not a valid v1 batch. Single bad entries are dropped, not the batch. */
    fun decode(json: String): WatchBatch? {
        if (json.length > MAX_MESSAGE_BYTES) return null
        return try {
            val o = JSONObject(json)
            val session = o.optString("session", "")
            val seq = o.optLong("seq", 0L)
            if (o.optInt("v", 0) != 1 || o.optLong("epochMs", 0L) != EngineConfig.EPOCH_MS) return null
            if (session.isEmpty() || session.length > 64 || seq < 1) return null
            val epochsJson = o.optJSONArray("epochs") ?: return null
            val hrJson = o.optJSONArray("hr") ?: return null
            val epochs = ArrayList<WatchEpoch>()
            for (i in 0 until epochsJson.length()) {
                val e = epochsJson.optJSONObject(i) ?: continue
                val t = e.optLong("t", -1L)
                val act = e.optDouble("act", Double.NaN)
                val n = e.optInt("n", 0)
                if (t >= 0 && act.isFinite() && act >= 0 && n >= 1) epochs.add(WatchEpoch(t, act, n))
            }
            val hr = ArrayList<HrSample>()
            for (i in 0 until hrJson.length()) {
                val p = hrJson.optJSONArray(i) ?: continue
                val t = p.optLong(0, -1L)
                val bpm = p.optDouble(1, Double.NaN)
                if (t >= 0 && bpm.isFinite() && bpm in 20.0..250.0) hr.add(HrSample(t, bpm))
            }
            epochs.sortBy { it.start }
            hr.sortBy { it.t }
            WatchBatch(session, seq, o.optLong("sentAt", 0L), epochs, hr)
        } catch (_: Exception) {
            null
        }
    }

    /** Registers a batch and returns it; null for malformed batches and for repeats. */
    fun accept(json: String, now: Long = System.currentTimeMillis()): WatchBatch? {
        val b = decode(json) ?: return null
        synchronized(lock) {
            if (!seen.add("${b.session}:${b.seq}")) return null
            if (seen.size > MAX_KEYS) seen.remove(seen.first())
            lastReceivedAt = now
            lastSession = b.session
            lastSeq = b.seq
        }
        return b
    }

    /** A new night starts: forget everything from earlier ones. */
    fun clear(ctx: Context) = synchronized(lock) {
        seen.clear()
        lastReceivedAt = 0L
        lastSession = null
        lastSeq = 0L
    }
}
