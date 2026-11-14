// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.wear

/** What the service tells the screen. Read from the main thread only after being written there, so plain fields. */
object WatchState {
    @Volatile var running = false
    @Volatile var startedAtMs = 0L
    @Volatile var hrNow: Double? = null
    @Volatile var hrAtMs = 0L
    @Volatile var batchesSent = 0
    @Volatile var batchesPending = 0

    /** null: not checked yet. */
    @Volatile var phoneConnected: Boolean? = null
    @Volatile var error: String? = null

    /** Name of the exercise type Health Services was started with; shown small, for diagnosing odd watches. */
    @Volatile var exerciseType: String? = null
}
