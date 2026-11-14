// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.engine

import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.EPOCH_MS
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private const val MIN = 60_000L
private val T0 = 1_800_000_000_000L - (1_800_000_000_000L % EPOCH_MS)

private fun still(t: Long) = MotionSample(t, 0.0, 0.0, 9.81)

/** Ports of the deterministic cases of tests/unit/{epochs,stager,smartAlarm}.test.ts. The statistical ones are covered by ParityTest. */
class EpochAggregatorTest {
    @Test fun closesAnEpochOnlyAfterTimePassesItsBoundary() {
        val a = EpochAggregator()
        assertTrue(a.ingestMotion(still(T0 + 1000)).isEmpty())
        assertTrue(a.ingestMotion(still(T0 + EPOCH_MS - 1)).isEmpty())
        assertTrue(a.ingestMotion(still(T0 + EPOCH_MS + 500)).isEmpty()) // inside the reorder grace
        val closed = a.ingestMotion(still(T0 + EPOCH_MS + 5000))
        assertEquals(1, closed.size)
        assertEquals(T0, closed[0].start)
        assertEquals(2, closed[0].motionSamples)
    }

    @Test fun isInsensitiveToMotionHrInterleaving() {
        fun run(order: String): Epoch? {
            val a = EpochAggregator()
            val out = ArrayList<Epoch>()
            val motion = (0 until 20).map { MotionSample(T0 + it * 1000L, 0.0, 0.0, 9.81 + (it % 2) * 0.1) }
            val hr = (0 until 20).map { HrSample(T0 + it * 1000L + 300, 60.0 + (it % 5)) }
            when (order) {
                "motionFirst" -> { motion.forEach { out += a.ingestMotion(it) }; hr.forEach { out += a.ingestHr(it) } }
                "hrFirst" -> { hr.forEach { out += a.ingestHr(it) }; motion.forEach { out += a.ingestMotion(it) } }
                else -> for (i in 0 until 20) { out += a.ingestHr(hr[i]); out += a.ingestMotion(motion[i]) }
            }
            out += a.advance(T0 + 3 * EPOCH_MS)
            return out.find { it.start == T0 }
        }
        val base = run("motionFirst")!!
        assertEquals(20, base.hrSamples)
        assertEquals(20, base.motionSamples)
        for (o in listOf("hrFirst", "mixed")) {
            val r = run(o)!!
            assertEquals(base.activity, r.activity, 1e-12)
            assertEquals(base.hrMean!!, r.hrMean!!, 1e-9)
            assertEquals(base.hrSd!!, r.hrSd!!, 1e-9)
        }
    }

    @Test fun keepsASlightlyLateHrPacketWithinGrace() {
        val a = EpochAggregator()
        a.ingestMotion(still(T0 + 1000))
        a.ingestMotion(still(T0 + EPOCH_MS + 1000))
        a.ingestHr(HrSample(T0 + EPOCH_MS - 500, 60.0))
        assertEquals(1, a.advance(T0 + 3 * EPOCH_MS)[0].hrSamples)
    }

    @Test fun givesIdenticalActivityForAnyPhoneOrientation() {
        fun activity(k: Int): Double {
            val a = EpochAggregator()
            for (i in 0 until 300) {
                val shake = Math.sin(i / 3.0) * 0.2 * (if (i > 100) 1 else 0)
                val x = 0.5
                val y = 0.3
                val z = 9.7 + shake
                val (ax, ay, az) = when (k) { 0 -> Triple(x, y, z); 1 -> Triple(z, -x, y); else -> Triple(-y, -z, x) }
                a.ingestMotion(MotionSample(T0 + i * 100L, ax, ay, az))
            }
            return a.advance(T0 + 5 * EPOCH_MS)[0].activity
        }
        assertEquals(activity(0), activity(1), 1e-12)
        assertEquals(activity(0), activity(2), 1e-12)
        assertTrue(activity(0) > 0.05)
    }

    @Test fun reportsGapsAsNaNActivityAndNullHr() {
        val a = EpochAggregator()
        val out = a.ingestMotion(still(T0 + 1000)) + a.ingestMotion(still(T0 + 3 * EPOCH_MS + 1000)) + a.advance(T0 + 5 * EPOCH_MS)
        assertEquals(listOf(T0, T0 + EPOCH_MS, T0 + 2 * EPOCH_MS, T0 + 3 * EPOCH_MS), out.map { it.start })
        assertTrue(out[1].activity.isNaN())
        assertNull(out[1].hrMean)
        assertEquals(0, out[1].motionSamples)
    }

    @Test fun rejectsNonFiniteSamplesAndDropsLateOnes() {
        val a = EpochAggregator()
        a.ingestMotion(still(T0 + 1000))
        a.ingestMotion(MotionSample(T0 + 2000, Double.NaN, 0.0, 9.81))
        a.ingestHr(HrSample(T0 + 2000, Double.NaN))
        assertEquals(2, a.rejected)
        a.advance(T0 + 3 * EPOCH_MS)
        a.ingestMotion(still(T0 + 5000))
        assertEquals(1, a.late)
    }

    @Test fun survivesAHugeForwardJump() {
        val a = EpochAggregator()
        a.ingestMotion(still(T0))
        assertTrue(a.advance(T0 + 400L * 24 * 3600_000).size <= 2_881)
    }

    @Test fun bucketsTimesBeforeTheEpochRoundDown() {
        // Math.floorDiv, not "/": with truncation a negative time would land in the wrong epoch.
        val a = EpochAggregator()
        a.ingestMotion(still(-1000))
        assertEquals(-EPOCH_MS, a.advance(2 * EPOCH_MS)[0].start)
    }
}

class StagerTest {
    @Test fun marksStillButNotYetDeepEpochsAsLowConfidenceLight() {
        val s = Stager()
        val r = (0 until 8).map { s.process(Epoch(it * EPOCH_MS, 0.002, null, null, 60, 0)) }
        assertEquals(Stage.LIGHT, r[2].stage)
        assertTrue(r[2].confidence < 0.5)
        assertEquals(Stage.DEEP, r[7].stage)
        assertTrue(r[7].confidence < 0.5)
    }

    @Test fun labelsSensorGapEpochsUnknown() {
        val r = Stager().process(Epoch(0, Double.NaN, null, null, 0, 0))
        assertEquals(EpochResult(0, Stage.UNKNOWN, 0.0), r)
    }

    @Test fun callsMovementWakeWithoutHr() {
        val s = Stager()
        val r = (0 until 6).map { s.process(Epoch(it * EPOCH_MS, 0.3, null, null, 60, 0)) }
        assertTrue(r.all { it.stage == Stage.WAKE })
    }
}

class SmartAlarmTest {
    private val start = 1_800_000_000_000L
    private val end = start + 30 * MIN
    private fun feed(a: SmartAlarm, stages: List<Stage>, first: Long, conf: Double = 0.8) =
        stages.forEachIndexed { i, st -> a.ingest(EpochResult(first + i * EPOCH_MS, st, conf)) }

    @Test fun hardFallbackFiresAtWindowEndWithNoData() {
        val a = SmartAlarm(start, end)
        assertNull(a.tick(start + MIN))
        assertNull(a.tick(end - 1))
        assertEquals(AlarmDecision(AlarmReason.FALLBACK, end, Stage.UNKNOWN), a.tick(end))
    }

    @Test fun firesOnTheFirstTickAfterAClockJumpAndOnlyOnce() {
        val a = SmartAlarm(start, end)
        assertNull(a.tick(start + MIN))
        val d = a.tick(end + 6 * 3600_000)
        assertEquals(AlarmReason.FALLBACK, d?.reason)
        assertNull(a.tick(end + 7 * 3600_000))
        assertNull(a.tick(end))
        assertEquals(d, a.decision)
    }

    @Test fun doesNotFireBeforeTheWindowOpens() {
        val a = SmartAlarm(start, end)
        feed(a, List(10) { Stage.LIGHT }, start - 10 * EPOCH_MS)
        assertNull(a.tick(start - 1))
    }

    @Test fun firesInsideTheWindowAfterALightRun() {
        val a = SmartAlarm(start, end)
        val first = start + 5 * MIN
        feed(a, List(4) { Stage.LIGHT }, first)
        val now = first + 4 * EPOCH_MS + 1000
        assertEquals(AlarmDecision(AlarmReason.SMART, now, Stage.LIGHT), a.tick(now))
    }

    @Test fun waitsOutTheDeepCooldownThenFires() {
        val a = SmartAlarm(start, end)
        val first = start + 5 * MIN
        feed(a, listOf(Stage.DEEP) + List(5) { Stage.LIGHT }, first)
        assertNull(a.tick(first + 6 * EPOCH_MS + 1000))
        feed(a, List(5) { Stage.LIGHT }, first + 6 * EPOCH_MS)
        assertEquals(AlarmReason.SMART, a.tick(first + 11 * EPOCH_MS + 1000)?.reason)
    }

    @Test fun refusesStaleDataAndLowConfidenceLight() {
        val first = start + 5 * MIN
        val a = SmartAlarm(start, end)
        feed(a, List(4) { Stage.LIGHT }, first)
        assertNull(a.tick(first + 4 * EPOCH_MS + 3 * EPOCH_MS))
        val b = SmartAlarm(start, end)
        feed(b, List(4) { Stage.LIGHT }, first, 0.2)
        assertNull(b.tick(first + 4 * EPOCH_MS + 1000))
    }

    @Test fun countsWakeAsGoodButNotRemOrUnknown() {
        fun mk(s: Stage): AlarmReason? {
            val a = SmartAlarm(start, end)
            val first = start + 5 * MIN
            feed(a, listOf(Stage.LIGHT, Stage.LIGHT, Stage.LIGHT, s), first)
            return a.tick(first + 4 * EPOCH_MS + 1000)?.reason
        }
        assertEquals(AlarmReason.SMART, mk(Stage.WAKE))
        assertNull(mk(Stage.REM))
        assertNull(mk(Stage.UNKNOWN))
    }

    @Test fun validatesTheWindow() {
        fun code(a: Long, b: Long): AlarmWindowError? = try { SmartAlarm(a, b); null } catch (e: AlarmWindowException) { e.code }
        assertEquals(AlarmWindowError.END_NOT_AFTER_START, code(start, start))
        assertEquals(AlarmWindowError.END_NOT_AFTER_START, code(start, start - MIN))
        assertEquals(AlarmWindowError.TOO_SHORT, code(start, start + EngineConfig.MIN_WINDOW_MS - 1))
        assertEquals(AlarmWindowError.TOO_LONG, code(start, start + 3 * 60 * MIN + 1))
        assertNull(code(start, start + EngineConfig.MIN_WINDOW_MS))
        assertNull(code(start, start + 3 * 60 * MIN))
    }

    @Test fun pipelineStillFallsBackWhenTheStagerThrows() {
        val p = Pipeline(start, end, stager = { throw IllegalStateException("stager defect") })
        var t = start
        while (t < end) {
            p.ingestMotion(MotionSample(t, Double.NaN, 0.0, 9.8))
            p.ingestMotion(MotionSample(t, 0.0, 0.0, 9.8))
            p.ingestHr(HrSample(t, 60.0))
            p.tick(t)
            t += 1000
        }
        assertTrue(p.pipelineErrors > 0)
        assertEquals(AlarmReason.FALLBACK, p.tick(end)?.reason)
    }
}

/** Native-only behaviour: resuming after the process was killed, and the watch feed rules. */
class ResumeAndWatchTest {
    private fun epochs(n: Int): List<Epoch> {
        // Mixed still and moving epochs with HR, long enough to pass the HR baseline (20 epochs).
        return (0 until n).map { i ->
            val moving = i % 11 == 0
            Epoch(T0 + i * EPOCH_MS, if (i == 13) Double.NaN else if (moving) 0.2 else 0.002, 55.0 + (i % 7) * 0.4, 0.8 + (i % 3) * 0.7, 300, 15)
        }
    }

    @Test fun restoringFromPersistedEpochsGivesTheSameStagesAsAnUninterruptedRun() {
        val all = epochs(80)
        val straight = Stager().let { s -> all.map { s.process(it) } }
        for (k in listOf(1, 7, 25, 60)) {
            val p = Pipeline(T0, T0 + 100 * EPOCH_MS)
            p.restore(all.take(k))
            val resumed = p.results.toMutableList()
            val stager = Stager().also { s -> all.take(k).forEach { s.process(it) } }
            all.drop(k).forEach { resumed.add(stager.process(it)) }
            assertEquals("restore at $k", straight, resumed)
        }
    }

    @Test fun aRestoredPipelineContinuesAfterTheLastPersistedEpoch() {
        val p = Pipeline(T0, T0 + 100 * EPOCH_MS)
        p.restore(epochs(10))
        // The next sample belongs to epoch 10; earlier ones are late, and no duplicate epoch is emitted.
        p.ingestMotion(still(T0 + 3 * EPOCH_MS))
        assertEquals(1, p.aggregator.late)
        val before = p.results.size
        p.ingestMotion(still(T0 + 10 * EPOCH_MS + 1000))
        p.tick(T0 + 12 * EPOCH_MS)
        assertEquals(before + 1, p.results.size)
        assertEquals(T0 + 10 * EPOCH_MS, p.results[before].start)
    }

    @Test fun watchBatchesAreShiftedFilteredAndActivityComesFirst() {
        val seen = ArrayList<String>()
        val pipe = Pipeline(T0, T0 + 100 * EPOCH_MS, stager = { e -> seen += "${e.start}:${e.motionSamples}:${e.hrSamples}"; EpochResult(e.start, Stage.LIGHT, 0.7) })
        val batch = WatchBatch(
            "s", 1, 0,
            listOf(WatchEpoch(T0 - 10 * EPOCH_MS, 0.01, 10), WatchEpoch(T0, 0.01, 298)),
            listOf(HrSample(T0 - 10 * EPOCH_MS, 50.0), HrSample(T0 + 1000, 58.0)),
        )
        val sel = SourceSelector(T0, watchEnabled = true)
        // Arrives 15 s after epoch T0 ended: fresh, so the watch is admitted.
        val now = T0 + EPOCH_MS + 15_000
        assertTrue(WatchFeed.apply(pipe, sel, batch, now, notBefore = T0 - 60_000))
        pipe.tick(T0 + 5 * EPOCH_MS)
        // Epoch T0 lands WATCH_SHIFT_MS later (two epochs); the old leftovers were dropped.
        assertEquals(listOf("${T0 + EngineConfig.WATCH_SHIFT_MS}:298:1"), seen.filter { it.contains(":298:") })
        assertFalse(WatchFeed.apply(pipe, sel, batch.copy(epochs = emptyList()), now, notBefore = 0))
    }

    @Test fun staleWatchActivityIsKeptOutButHeartRateStillCounts() {
        val seen = ArrayList<Epoch>()
        val pipe = Pipeline(T0, T0 + 100 * EPOCH_MS, stager = { e -> seen += e; EpochResult(e.start, Stage.LIGHT, 0.7) })
        val sel = SourceSelector(T0, watchEnabled = true)
        // The watch never delivered; after the grace period the phone is the source.
        val late = T0 + EngineConfig.WATCH_GRACE_MS + 10 * EPOCH_MS
        assertEquals(EpochSource.PHONE, sel.source(late))
        val batch = WatchBatch("s", 1, 0, listOf(WatchEpoch(late - EPOCH_MS - 10_000, 0.5, 100)), listOf(HrSample(late - 40_000, 58.0)))
        assertFalse(WatchFeed.apply(pipe, sel, batch, late, notBefore = 0))
        pipe.ingestMotion(still(late + 60_000))
        pipe.tick(late + 5 * EPOCH_MS)
        assertTrue(seen.none { it.source == EpochSource.WATCH })
        assertTrue(seen.any { it.hrSamples > 0 })
        assertEquals(0, pipe.aggregator.crossSource)
    }

    @Test fun anEpochKeepsOneMotionSourceAndTheOtherIsRefusedAndCounted() {
        val a = EpochAggregator()
        a.ingestActivity(ActivitySample(T0 + 5_000, 0.02, 100))
        a.ingestMotion(still(T0 + 6_000))
        a.ingestMotion(MotionSample(T0 + 7_000, 3.0, 0.0, 9.81))
        assertEquals(2, a.crossSource)
        val e = a.advance(T0 + 40_000).single()
        assertEquals(EpochSource.WATCH, e.source)
        assertEquals(100, e.motionSamples)
        assertEquals(0.02, e.activity, 1e-12)
        // Gaps and heart-rate-only epochs have no source.
        val b = EpochAggregator()
        val out = b.ingestHr(HrSample(T0 + 1000, 60.0)) + b.advance(T0 + 4 * EPOCH_MS)
        assertTrue(out.all { it.source == null })
    }

    @Test fun wristEpochsUseTheWristThresholds() {
        // Same activity, same history; only the source differs. With equal thresholds the labels are equal.
        fun stage(src: EpochSource) = Stager().process(Epoch(T0, 0.05, null, null, 100, 0, src)).stage
        assertEquals(stage(EpochSource.PHONE), stage(EpochSource.WATCH))
        assertEquals(Stage.WAKE, stage(EpochSource.WATCH))
        assertEquals(EngineConfig.WAKE_THRESHOLD, EngineConfig.WAKE_THRESHOLD_WATCH, 0.0)
        assertEquals(EngineConfig.STILL_ACTIVITY, EngineConfig.STILL_ACTIVITY_WATCH, 0.0)
    }

    @Test fun validateWindowThrowsTypedError() {
        try { validateWindow(5, 5); fail("expected") } catch (_: AlarmWindowException) { }
    }
}
