// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Runs the shared synthetic nights (tests/fixtures/engine-parity, written by the JavaScript engine's test suite)
 * through the Kotlin engine and demands the same stages and the same wake decision. The replay loop is the one
 * of the JS fixture generator: samples merged by time up to each 5 s tick, motion before heart rate on ties,
 * phone motion gated by the SourceSelector, watch batches applied through WatchFeed (selector, 60 s shift), then pipeline.tick(t), stopping at the first decision.
 *
 * Stages and the decision (reason, time, stage) must match exactly. Floating values only need to agree to 1e-9:
 * V8 and the JVM may round the last bit of hypot/exp differently.
 */
class ParityTest {
    @Suppress("UNCHECKED_CAST")
    private fun load(name: String): Map<String, Any?> {
        val text = javaClass.classLoader!!.getResourceAsStream("$name.json")!!.bufferedReader().readText()
        return MiniJson.parse(text) as Map<String, Any?>
    }

    private fun longOf(x: Any?) = (x as Double).toLong()

    @Suppress("UNCHECKED_CAST")
    private fun check(name: String) {
        val fx = load(name)
        val startMs = longOf(fx["startMs"])
        val windowStart = longOf(fx["windowStart"])
        val windowEnd = longOf(fx["windowEnd"])
        val tickMs = longOf(fx["tickMs"])
        val motion = fx["motion"] as List<Double>
        val hr = fx["hr"] as List<Double>
        val batches = fx["watchBatches"] as List<Map<String, Any?>>
        val expected = fx["expected"] as Map<String, Any?>

        val inputs = ArrayList<Epoch>()
        val stager = Stager()
        val selector = SourceSelector(startMs, fx["useWatch"] as Boolean)
        val pipe = Pipeline(windowStart, windowEnd, stager = { e -> inputs.add(e); stager.process(e) })

        var mi = 0
        var hi = 0
        var bi = 0
        var decision: AlarmDecision? = null
        var t = startMs
        while (decision == null) {
            val mAt = { if (mi < motion.size) startMs + motion[mi].toLong() else Long.MAX_VALUE }
            val hAt = { if (hi < hr.size) startMs + hr[hi].toLong() else Long.MAX_VALUE }
            while (true) {
                val mT = mAt()
                val hT = hAt()
                val mOk = mT <= t
                val hOk = hT <= t
                if (!mOk && !hOk) break
                if (mOk && (!hOk || mT <= hT)) {
                    // Phone motion is consumed either way but only used while the phone is the motion source.
                    if (selector.source(t) == EpochSource.PHONE) pipe.ingestMotion(MotionSample(mT, motion[mi + 1], motion[mi + 2], motion[mi + 3]))
                    mi += 4
                } else {
                    pipe.ingestHr(HrSample(hT, hr[hi + 1]))
                    hi += 2
                }
            }
            while (bi < batches.size && longOf(batches[bi]["arrival"]) <= t) {
                val b = batches[bi++]
                val epochs = (b["epochs"] as List<List<Double>>).map { WatchEpoch(it[0].toLong(), it[1], it[2].toInt()) }
                val hrs = (b["hr"] as List<List<Double>>).map { HrSample(it[0].toLong(), it[1]) }
                WatchFeed.apply(pipe, selector, WatchBatch("fixture", bi.toLong(), 0, epochs, hrs), t, notBefore = Long.MIN_VALUE)
            }
            decision = pipe.tick(t)
            if (t >= windowEnd) break
            t = minOf(t + tickMs, windowEnd)
        }

        val exp = expected["epochs"] as List<Map<String, Any?>>
        assertEquals("$name: epoch count", exp.size, pipe.results.size)
        for (k in exp.indices) {
            val want = exp[k]
            val got = pipe.results[k]
            assertEquals("$name epoch $k start", longOf(want["start"]), got.start)
            assertEquals("$name epoch $k stage", want["stage"], got.stage.wire)
            assertEquals("$name epoch $k confidence", want["confidence"] as Double, got.confidence, 1e-9)
            val act = want["activity"] as Double?
            val gotAct = inputs[k].activity
            if (act == null) assertTrue("$name epoch $k activity should be NaN", gotAct.isNaN()) else assertEquals("$name epoch $k activity", act, gotAct, 1e-9)
            val hm = want["hrMean"] as Double?
            val gotHm = inputs[k].hrMean
            if (hm == null) assertEquals(null, gotHm) else assertEquals("$name epoch $k hrMean", hm, gotHm!!, 1e-9)
            assertEquals("$name epoch $k source", want["source"], inputs[k].source?.wire)
        }
        val d = expected["decision"] as Map<String, Any?>
        assertNotNull("$name: a decision must exist", decision)
        assertEquals("$name decision reason", d["reason"], decision!!.reason.wire)
        assertEquals("$name decision time", longOf(d["at"]), decision.at)
        assertEquals("$name decision stage", d["stage"], decision.stageAtTrigger.wire)
    }

    @Test fun phoneHrSmart() = check("phone-hr-smart")

    @Test fun phoneMotionOnlySmart() = check("phone-motion-only-smart")

    @Test fun phoneDropoutFallback() = check("phone-dropout-fallback")

    @Test fun watchHrSmart() = check("watch-hr-smart")

    @Test fun watchStalePhoneWatch() = check("watch-stale-phone-watch")
}
