// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.engine

import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.EPOCH_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.SENSOR_ADVANCE_LAG_MS
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig.SENSOR_MAX_LATENCY_MS
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

private val T0 = 1_800_000_000_000L - (1_800_000_000_000L % EPOCH_MS)

/**
 * The accelerometer is read with batching, so a sample reaches the engine up to SENSOR_MAX_LATENCY_MS after its
 * own timestamp, while the 5 s ticker uses the wall clock. These tests deliver samples the way the sensor hub does.
 */
class BatchingTest {
    private fun sample(t: Long) = MotionSample(t, 0.0, 0.0, 9.81)

    /** Samples at 10 Hz with timestamps in [from, to). */
    private fun samples(from: Long, to: Long) = (from until to step 100).map(::sample)

    private val far = T0 + 100 * EPOCH_MS

    @Test fun aBatchDeliveredAfterATickIsFullyCounted() {
        val epochs = ArrayList<Epoch>()
        val p = Pipeline(far, far + 30 * 60_000, stager = { e -> epochs.add(e); EpochResult(e.start, Stage.LIGHT, 0.7) })
        // First 20 s delivered at wall T0+20 s, then a tick at T0+25 s while the next batch is still in the FIFO.
        samples(T0, T0 + 20_000).forEach(p::ingestMotion)
        p.tick(T0 + 25_000, T0 + 25_000 - SENSOR_ADVANCE_LAG_MS)
        p.tick(T0 + 36_000, T0 + 36_000 - SENSOR_ADVANCE_LAG_MS)
        samples(T0 + 20_000, T0 + 40_000).forEach(p::ingestMotion)
        p.tick(T0 + 41_000, T0 + 41_000 - SENSOR_ADVANCE_LAG_MS)
        samples(T0 + 40_000, T0 + 70_000).forEach(p::ingestMotion)
        assertEquals(0, p.aggregator.late)
        assertEquals(300, epochs.first { it.start == T0 }.motionSamples)
    }

    @Test fun advancingToTheClockWouldHaveLostThem() {
        // The behaviour this guards against: same delivery, aggregator advanced to the wall clock.
        val p = Pipeline(far, far + 30 * 60_000)
        samples(T0, T0 + 20_000).forEach(p::ingestMotion)
        p.tick(T0 + 36_000)
        samples(T0 + 20_000, T0 + 40_000).forEach(p::ingestMotion)
        assertTrue(p.aggregator.late > 0)
    }

    @Test fun irregularBatchesAndTicksLoseNoSample() {
        val rnd = Random(7)
        val epochs = ArrayList<Epoch>()
        val p = Pipeline(far, far + 30 * 60_000, stager = { e -> epochs.add(e); EpochResult(e.start, Stage.LIGHT, 0.7) })
        val total = 10 * EPOCH_MS
        var delivered = T0 // samples with t < delivered have reached the engine
        var wall = T0
        while (delivered < T0 + total) {
            // Next batch: 5..20 s of samples, flushed at a wall time up to the latency after its newest sample.
            val newest = minOf(T0 + total, delivered + 5_000 + rnd.nextInt(151) * 100L)
            val flushAt = newest + rnd.nextInt(2_000).toLong() // delivery lag after the newest sample
            // Ticks every 5 s between the last delivery and this one use the wall clock.
            while (wall + 5_000 < flushAt) {
                wall += 5_000
                p.tick(wall, wall - SENSOR_ADVANCE_LAG_MS)
            }
            samples(delivered, newest).forEach(p::ingestMotion)
            delivered = newest
            wall = maxOf(wall, flushAt)
            p.tick(wall, wall - SENSOR_ADVANCE_LAG_MS)
        }
        p.tick(T0 + total + 60_000, T0 + total + 60_000 - SENSOR_ADVANCE_LAG_MS)
        assertEquals(0, p.aggregator.late)
        assertEquals(10, epochs.count { it.start in T0 until T0 + total })
        assertTrue(epochs.filter { it.start in T0 until T0 + total }.all { it.motionSamples == 300 })
    }

    @Test fun theLagCoversTheSensorLatency() {
        assertTrue(SENSOR_ADVANCE_LAG_MS > SENSOR_MAX_LATENCY_MS + EngineConfig.REORDER_GRACE_MS)
    }

    @Test fun theWindowEndFallbackStillUsesTheRealClock() {
        val p = Pipeline(T0, T0 + 20 * 60_000)
        val end = T0 + 20 * 60_000
        assertEquals(AlarmReason.FALLBACK, p.tick(end, end - SENSOR_ADVANCE_LAG_MS)?.reason)
    }
}

/** EngineConfig must equal the JavaScript constants exported to tests/fixtures/engine-parity/config.json. */
class ConfigParityTest {
    @Test fun constantsMatchTheJavaScriptEngine() {
        @Suppress("UNCHECKED_CAST")
        val js = MiniJson.parse(javaClass.classLoader!!.getResourceAsStream("config.json")!!.bufferedReader().readText()) as Map<String, Any?>
        fun num(k: String) = js[k] as Double
        val kt = mapOf(
            "EPOCH_MS" to EngineConfig.EPOCH_MS.toDouble(),
            "REORDER_GRACE_MS" to EngineConfig.REORDER_GRACE_MS.toDouble(),
            "GRAVITY_TAU_MS" to EngineConfig.GRAVITY_TAU_MS,
            "MAX_GAP_EPOCHS" to EngineConfig.MAX_GAP_EPOCHS.toDouble(),
            "MIN_HR_SAMPLES_FOR_SD" to EngineConfig.MIN_HR_SAMPLES_FOR_SD.toDouble(),
            "WAKE_THRESHOLD" to EngineConfig.WAKE_THRESHOLD,
            "STILL_ACTIVITY" to EngineConfig.STILL_ACTIVITY,
            "DEEP_STILL_EPOCHS" to EngineConfig.DEEP_STILL_EPOCHS.toDouble(),
            "BASELINE_MIN_HR_EPOCHS" to EngineConfig.BASELINE_MIN_HR_EPOCHS.toDouble(),
            "DEEP_HR_MARGIN_BPM" to EngineConfig.DEEP_HR_MARGIN_BPM,
            "DEEP_SD_RATIO" to EngineConfig.DEEP_SD_RATIO,
            "REM_SD_RATIO" to EngineConfig.REM_SD_RATIO,
            "REM_STILL_EPOCHS" to EngineConfig.REM_STILL_EPOCHS.toDouble(),
            "MIN_WINDOW_MS" to EngineConfig.MIN_WINDOW_MS.toDouble(),
            "MAX_WINDOW_MS" to EngineConfig.MAX_WINDOW_MS.toDouble(),
            "LIGHT_RUN_EPOCHS" to EngineConfig.LIGHT_RUN_EPOCHS.toDouble(),
            "DEEP_COOLDOWN_EPOCHS" to EngineConfig.DEEP_COOLDOWN_EPOCHS.toDouble(),
            "FRESH_EPOCHS" to EngineConfig.FRESH_EPOCHS.toDouble(),
            "SMART_MIN_CONFIDENCE" to EngineConfig.SMART_MIN_CONFIDENCE,
            "WAKE_THRESHOLD_WATCH" to EngineConfig.WAKE_THRESHOLD_WATCH,
            "STILL_ACTIVITY_WATCH" to EngineConfig.STILL_ACTIVITY_WATCH,
            "WATCH_RECOVER_EPOCHS" to EngineConfig.WATCH_RECOVER_EPOCHS.toDouble(),
            "WATCH_RECOVER_MS" to EngineConfig.WATCH_RECOVER_MS.toDouble(),
            "WATCH_SHIFT_MS" to EngineConfig.WATCH_SHIFT_MS.toDouble(),
            "WATCH_FRESH_MS" to EngineConfig.WATCH_FRESH_MS.toDouble(),
            "WATCH_GRACE_MS" to EngineConfig.WATCH_GRACE_MS.toDouble(),
        )
        for ((k, v) in kt) assertEquals(k, num(k), v, 0.0)
        @Suppress("UNCHECKED_CAST")
        val ck = (js["CK_WEIGHTS"] as List<Double>).toDoubleArray()
        assertTrue("CK_WEIGHTS", ck.contentEquals(EngineConfig.CK_WEIGHTS))
        // Every exported constant must be checked here, so a new one cannot be forgotten.
        assertEquals((kt.keys + "CK_WEIGHTS").toSet(), js.keys)
    }
}
