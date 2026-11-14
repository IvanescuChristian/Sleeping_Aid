// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import io.github.ivanescuchristian.sleepingaid.engine.Epoch
import io.github.ivanescuchristian.sleepingaid.engine.EpochResult
import io.github.ivanescuchristian.sleepingaid.engine.Stage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The epoch line is what a restarted night replays, so it must round-trip every field exactly, gaps included. */
class NightStoreFormatTest {
    private fun roundTrip(e: Epoch, r: EpochResult) = NightStore.parse(NightStore.format(e, r))

    @Test fun roundTripsAFullEpochWithHeartRate() {
        val e = Epoch(1_800_000_030_000, 0.0031234567890123, 57.123456789, 1.0000000000000002, 298, 15)
        val r = EpochResult(e.start, Stage.REM, 0.65)
        val back = roundTrip(e, r)!!
        assertEquals(e, back.epoch)
        assertEquals(r, back.result)
    }

    @Test fun roundTripsAGapEpochWithNaNActivityAndNoHeartRate() {
        val e = Epoch(1_800_000_060_000, Double.NaN, null, null, 0, 0)
        val r = EpochResult(e.start, Stage.UNKNOWN, 0.0)
        val back = roundTrip(e, r)!!
        assertEquals(e, back.epoch) // data class equality treats NaN as equal to NaN
        assertEquals(r, back.result)
    }

    @Test fun keepsHeartRateMeanWhenTheSdIsMissing() {
        val e = Epoch(1_800_000_090_000, 0.002, 60.0, null, 100, 3)
        assertEquals(e, roundTrip(e, EpochResult(e.start, Stage.LIGHT, 0.6))!!.epoch)
    }

    @Test fun rejectsTornAndUnknownLines() {
        assertNull(NightStore.parse(""))
        assertNull(NightStore.parse("1800000000000,light,0.6,0.0,,,175")) // cut off by a kill mid-write
        assertNull(NightStore.parse("1800000000000,bogus,0.6,0.0,,,175,0"))
        assertNull(NightStore.parse("x,light,0.6,0.0,,,175,0"))
    }
}
