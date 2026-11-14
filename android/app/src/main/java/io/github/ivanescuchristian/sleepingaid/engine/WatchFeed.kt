// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.engine

import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.WATCH_FRESH_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.WATCH_GRACE_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.WATCH_SHIFT_MS

/** One activity epoch from the watch (wire schema v1, see android/wear Protocol.kt). [start] is the unshifted watch clock. */
data class WatchEpoch(val start: Long, val activity: Double, val samples: Int)

data class WatchBatch(val session: String, val seq: Long, val sentAt: Long, val epochs: List<WatchEpoch>, val hr: List<HrSample>)

enum class MotionSource { WATCH, PHONE }

object WatchFeed {
    /**
     * Port of the feeding logic in src/native/watch.ts follow(): leftovers before [notBefore] are ignored, every
     * timestamp moves WATCH_SHIFT_MS later, and activity goes in before the heart rate of the same batch (the
     * aggregator closes an epoch as soon as it sees a later sample). Returns true when the batch carried
     * activity, which keeps the watch counted as the live motion source.
     */
    fun apply(pipeline: Pipeline, batch: WatchBatch, notBefore: Long): Boolean {
        val epochs = batch.epochs.filter { it.start >= notBefore }
        val hr = batch.hr.filter { it.t >= notBefore }
        for (e in epochs) pipeline.ingestActivity(ActivitySample(e.start + WATCH_SHIFT_MS, e.activity, e.samples))
        for (p in hr) pipeline.ingestHr(HrSample(p.t + WATCH_SHIFT_MS, p.bpm))
        return epochs.isNotEmpty()
    }

    /** Port of chooseMotionSource: both sources must never run together, they add to the same epoch accumulator. */
    fun chooseMotionSource(now: Long, startedAt: Long, lastActivityAt: Long): MotionSource =
        if (lastActivityAt > 0) {
            if (now - lastActivityAt < WATCH_FRESH_MS) MotionSource.WATCH else MotionSource.PHONE
        } else if (now - startedAt < WATCH_GRACE_MS) {
            MotionSource.WATCH
        } else {
            MotionSource.PHONE
        }
}
