// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.engine

/**
 * Wires aggregator, stager and alarm, port of src/engine/pipeline.ts. Every sensor-side step is fenced by
 * try/catch and tick() always reaches the alarm, so a defect upstream degrades to "fallback only".
 *
 * [onEpoch] is called for each closed epoch with its input and its label; the night service persists them
 * so [restore] can rebuild the exact state after the process was killed.
 */
class Pipeline(
    windowStart: Long,
    windowEnd: Long,
    private val stager: EpochStager = Stager(),
    private val onEpoch: ((Epoch, EpochResult) -> Unit)? = null,
) {
    val aggregator = EpochAggregator()
    val alarm = SmartAlarm(windowStart, windowEnd)
    val results = ArrayList<EpochResult>()
    var pipelineErrors = 0
        private set

    fun ingestMotion(s: MotionSample) = guarded { process(aggregator.ingestMotion(s)) }

    fun ingestActivity(s: ActivitySample) = guarded { process(aggregator.ingestActivity(s)) }

    fun ingestHr(s: HrSample) = guarded { process(aggregator.ingestHr(s)) }

    /**
     * [nowMs] is the wall clock for the window rules (the fallback must fire on time). [advanceToMs] is how far
     * the aggregator may close epochs by time alone: with batched sensor events it must trail the clock, see
     * EngineConfig.SENSOR_ADVANCE_LAG_MS. The default (the clock itself) is the JavaScript behaviour.
     */
    fun tick(nowMs: Long, advanceToMs: Long = nowMs): AlarmDecision? {
        guarded { process(aggregator.advance(advanceToMs)) }
        return alarm.tick(nowMs)
    }

    /**
     * Replays persisted epochs without calling [onEpoch] and continues after the last one. The stager is causal,
     * so its labels equal the ones of the original run, and the alarm sees the same recent history.
     */
    fun restore(epochs: List<Epoch>) {
        for (e in epochs) {
            guarded {
                val r = stager.process(e)
                results.add(r)
                alarm.ingest(r)
            }
        }
        epochs.lastOrNull()?.let { aggregator.resumeAt(it.start + EngineConfig.EPOCH_MS) }
    }

    private inline fun guarded(step: () -> Unit) {
        try {
            step()
        } catch (_: Exception) {
            pipelineErrors++
        }
    }

    private fun process(epochs: List<Epoch>) {
        for (e in epochs) {
            guarded {
                val r = stager.process(e)
                results.add(r)
                alarm.ingest(r)
                onEpoch?.invoke(e, r)
            }
        }
    }
}
