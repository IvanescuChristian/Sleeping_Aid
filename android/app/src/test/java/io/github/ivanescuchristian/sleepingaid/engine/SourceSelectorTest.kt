// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.engine

import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.EPOCH_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.WATCH_FRESH_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.WATCH_GRACE_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.WATCH_RECOVER_EPOCHS
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors tests/unit/sourceSelector.test.ts: both engines must agree on every rule. */
class SourceSelectorTest {
    private val t0 = 1_800_000_000_000L
    private val sec = 1000L
    private fun start(k: Int) = t0 + k * EPOCH_MS
    private fun arrival(k: Int, lag: Long = 15 * sec) = start(k) + EPOCH_MS + lag
    private fun make(enabled: Boolean = true) = SourceSelector(t0, enabled)

    private fun deliver(sel: SourceSelector, from: Int, to: Int): List<EpochSource> =
        (from until to).map { k ->
            sel.onWatchEpochs(arrival(k), listOf(start(k)))
            sel.source(arrival(k))
        }

    @Test fun usesThePhoneOnlyWhenTheWatchIsNotWanted() {
        val sel = make(false)
        sel.onWatchEpochs(arrival(0), listOf(start(0)))
        assertEquals(EpochSource.PHONE, sel.source(t0))
        assertEquals(EpochSource.PHONE, sel.source(t0 + 10 * 3_600_000L))
        assertEquals(0, sel.switches)
    }

    @Test fun waitsForTheWatchDuringGraceThenFallsBack() {
        val sel = make()
        assertEquals(EpochSource.WATCH, sel.source(t0 + WATCH_GRACE_MS - 1))
        assertFalse(sel.watchSeen)
        assertEquals(EpochSource.PHONE, sel.source(t0 + WATCH_GRACE_MS))
    }

    @Test fun staysOnTheWatchWhileFreshEpochsKeepArriving() {
        val sel = make()
        assertEquals(setOf(EpochSource.WATCH), deliver(sel, 0, 120).toSet())
        assertEquals(0, sel.switches)
    }

    @Test fun goesStaleExactlyAtTheTimeout() {
        val sel = make()
        deliver(sel, 0, 10)
        val last = arrival(9)
        assertEquals(EpochSource.WATCH, sel.source(last + WATCH_FRESH_MS - 1))
        assertEquals(EpochSource.PHONE, sel.source(last + WATCH_FRESH_MS))
    }

    @Test fun returnsToTheWatchOnlyAfterTheHysteresis() {
        val sel = make()
        deliver(sel, 0, 10)
        assertEquals(EpochSource.PHONE, sel.source(arrival(29)))
        val answers = deliver(sel, 30, 36)
        assertEquals(List(WATCH_RECOVER_EPOCHS - 1) { EpochSource.PHONE }, answers.take(WATCH_RECOVER_EPOCHS - 1))
        assertEquals(EpochSource.WATCH, answers[WATCH_RECOVER_EPOCHS - 1])
        assertEquals(2, sel.switches)
    }

    @Test fun aBacklogFlushIsNotProofOfLife() {
        val sel = make()
        deliver(sel, 0, 10)
        val now = arrival(100)
        assertEquals(EpochSource.PHONE, sel.source(now))
        sel.onWatchEpochs(now, (0 until 50).map { start(40 + it) })
        assertEquals(EpochSource.PHONE, sel.source(now))
    }

    @Test fun repeatedEpochsCannotSatisfyTheHysteresis() {
        val sel = make()
        deliver(sel, 0, 3)
        val t = arrival(40)
        for (i in 0 until 5) sel.onWatchEpochs(t + i * sec, listOf(start(39)))
        assertEquals(EpochSource.PHONE, sel.source(t + 10 * sec))
    }

    @Test fun aWatchThatIsUpUnderAMinuteAtATimeNeverGetsBackIn() {
        val sel = make()
        deliver(sel, 0, 10)
        var k = 30
        repeat(8) {
            deliver(sel, k, k + 2)
            assertEquals(EpochSource.PHONE, sel.source(arrival(k + 1)))
            k += 8
        }
        assertEquals(1, sel.switches)
    }

    @Test fun flappingWithLongEnoughBurstsSwitchesABoundedNumberOfTimes() {
        val sel = make()
        var k = 0
        repeat(17) {
            deliver(sel, k, k + 8)
            k += 15
            sel.source(arrival(k - 1))
        }
        val hours = k * EPOCH_MS / 3_600_000.0
        assertTrue(sel.switches <= Math.ceil(hours * 60 / 3.5).toInt() * 2)
        assertTrue(sel.switches > 2)
    }

    @Test fun aLateEpochAfterALongGapStartsARecoveryInsteadOfRefreshingTheWatch() {
        val sel = make()
        deliver(sel, 0, 5)
        deliver(sel, 40, 41)
        assertEquals(EpochSource.PHONE, sel.source(arrival(40)))
    }

    @Test fun neitherSourceAvailableLeavesGapEpochsWithoutSource() {
        // Watch stale and no phone samples: the engine keeps emitting epochs, each unknown and sourceless.
        val gaps = ArrayList<Pair<Epoch, EpochResult>>()
        val stager = Stager()
        val pipe = Pipeline(t0, t0 + 10_000_000, stager = { e -> stager.process(e).also { gaps += e to it } })
        pipe.ingestHr(HrSample(t0 + 1000, 60.0))
        pipe.tick(t0 + 6 * EPOCH_MS)
        assertTrue(gaps.isNotEmpty())
        assertTrue(gaps.all { (e, r) -> e.source == null && r.stage == Stage.UNKNOWN })
        // No epoch twice, none skipped.
        assertEquals(gaps.indices.map { t0 + it * EPOCH_MS }, gaps.map { it.first.start })
    }
}
