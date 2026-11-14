// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The "already rang" guard of HardAlarm.schedule, which must keep working after a smart wake moves the trigger time. */
class AlarmStoreGuardTest {
    private val windowEnd = 1_800_000_000_000L

    @Test fun aRingForTheSameWindowEndIsNotArmedAgain() {
        assertTrue(AlarmStore.Record(windowEnd, "x", AlarmStore.State.FIRED).alreadyFiredFor(windowEnd))
    }

    @Test fun aSmartWakeThatMovedTheTriggerTimeStillBlocksTheOriginalWindowEnd() {
        val pending = AlarmStore.Record(windowEnd, "x", AlarmStore.State.PENDING)
        val moved = pending.copy(at = windowEnd - 600_000).copy(state = AlarmStore.State.FIRED)
        assertEquals(windowEnd, moved.windowEnd)
        assertTrue(moved.alreadyFiredFor(windowEnd))
    }

    @Test fun aPendingAlarmOrADifferentTimeIsArmedNormally() {
        assertFalse(AlarmStore.Record(windowEnd, "x", AlarmStore.State.PENDING).alreadyFiredFor(windowEnd))
        assertFalse(AlarmStore.Record(windowEnd, "x", AlarmStore.State.FIRED).alreadyFiredFor(windowEnd + 9 * 60_000)) // snooze
    }

    @Test fun aRecordWithoutTheFieldFallsBackToItsTriggerTime() {
        assertEquals(windowEnd, AlarmStore.Record(windowEnd, "x", AlarmStore.State.PENDING).windowEnd)
    }
}
