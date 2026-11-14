// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.engine

import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.WATCH_SHIFT_MS

/** One activity epoch from the watch (wire schema v1, see android/wear Protocol.kt). [start] is the unshifted watch clock. */
data class WatchEpoch(val start: Long, val activity: Double, val samples: Int)

data class WatchBatch(val session: String, val seq: Long, val sentAt: Long, val epochs: List<WatchEpoch>, val hr: List<HrSample>)

object WatchFeed {
    /**
     * Port of applyWatchBatch (src/engine/watchFeed.ts) for a batch that arrived at [now]. Leftovers before
     * [notBefore] are ignored and every timestamp moves WATCH_SHIFT_MS later. The selector sees the epochs first;
     * wrist activity enters only while the watch is the motion source, otherwise it would be a second source for
     * minutes the phone already covers. Heart rate has no phone counterpart, so it is never gated by the motion
     * source. Activity goes in before the heart rate of the same batch (the aggregator closes an epoch at the
     * next sample). Returns true when the batch's activity was admitted.
     */
    fun apply(pipeline: Pipeline, selector: SourceSelector, batch: WatchBatch, now: Long, notBefore: Long): Boolean {
        val epochs = batch.epochs.filter { it.start >= notBefore }
        val hr = batch.hr.filter { it.t >= notBefore }
        selector.onWatchEpochs(now, epochs.map { it.start })
        val admit = selector.source(now) == EpochSource.WATCH
        if (admit) for (e in epochs) pipeline.ingestActivity(ActivitySample(e.start + WATCH_SHIFT_MS, e.activity, e.samples))
        for (p in hr) pipeline.ingestHr(HrSample(p.t + WATCH_SHIFT_MS, p.bpm))
        return admit && epochs.isNotEmpty()
    }
}
