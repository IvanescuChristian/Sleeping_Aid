// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.engine

import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.EPOCH_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.REORDER_GRACE_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.WATCH_FRESH_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.WATCH_GRACE_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.WATCH_RECOVER_EPOCHS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.WATCH_RECOVER_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.WATCH_SHIFT_MS

/**
 * Decides which device feeds motion, watch first. Port of src/engine/sourceSelector.ts. Pure: time only enters
 * through `now`, so the same call sequence gives the same answers as the TypeScript engine (the parity fixtures
 * replay one in both).
 *
 * The watch is the source while it is live. It stops being live after WATCH_FRESH_MS without a fresh epoch (at the
 * start of a night: after WATCH_GRACE_MS without one). It becomes the source again only after
 * WATCH_RECOVER_EPOCHS consecutive fresh epochs over at least WATCH_RECOVER_MS (hysteresis against flapping).
 * The selector only gates inputs; the aggregator additionally refuses to mix sources inside one epoch.
 *
 * Not thread safe: NightTracker calls it under its lock.
 */
class SourceSelector(private val startedAt: Long, private val watchEnabled: Boolean) {
    private var current = if (watchEnabled) EpochSource.WATCH else EpochSource.PHONE
    private var lastFreshAt = 0L
    private var lastCountedStart = Long.MIN_VALUE
    private var recoverCount = 0
    private var recoverFirstAt = 0L
    private var recoverLastAt = 0L

    /** Number of source changes so far; bounded by the hysteresis, asserted in tests. */
    var switches = 0
        private set

    /** True once a fresh watch epoch has been seen (before that the watch is "waiting", not "stale"). */
    val watchSeen: Boolean get() = lastFreshAt > 0

    /** Report the epoch starts (watch clock, unshifted) of a batch that arrived at [now]. */
    fun onWatchEpochs(now: Long, starts: List<Long>) {
        if (!watchEnabled) return
        // Staleness first: after a long silence the first new epoch must start a recovery, not refresh the watch.
        source(now)
        for (start in starts.sorted()) {
            if (start <= lastCountedStart) continue
            lastCountedStart = start
            if (now - (start + EPOCH_MS) > MAX_EPOCH_AGE_MS) continue
            lastFreshAt = now
            if (current == EpochSource.WATCH) continue
            if (recoverCount > 0 && now - recoverLastAt >= WATCH_FRESH_MS) recoverCount = 0
            if (recoverCount == 0) recoverFirstAt = now
            recoverCount++
            recoverLastAt = now
            if (recoverCount >= WATCH_RECOVER_EPOCHS && now - recoverFirstAt >= WATCH_RECOVER_MS) {
                current = EpochSource.WATCH
                switches++
                recoverCount = 0
            }
        }
    }

    /** The source that may feed motion at [now]. Call on every tick so staleness is noticed without any input. */
    fun source(now: Long): EpochSource {
        if (!watchEnabled) return EpochSource.PHONE
        if (current == EpochSource.WATCH) {
            val stale = if (lastFreshAt > 0) now - lastFreshAt >= WATCH_FRESH_MS else now - startedAt >= WATCH_GRACE_MS
            if (stale) {
                current = EpochSource.PHONE
                switches++
                recoverCount = 0
            }
        }
        return current
    }

    companion object {
        /**
         * A watch epoch is fresh while the aggregator can still accept it: it arrives before its shifted epoch has
         * closed. Older ones (a reconnect flushing backlog) would be dropped as late anyway.
         */
        const val MAX_EPOCH_AGE_MS = WATCH_SHIFT_MS + REORDER_GRACE_MS
    }
}
