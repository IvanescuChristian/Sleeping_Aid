// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService

/**
 * Receives the watch's epoch batches, also while the app is closed (Google Play services wakes this service),
 * and feeds them straight into the native engine. Repeats (the watch re-sends what it could not confirm) are
 * dropped by (session, seq) before they reach the engine.
 */
class WatchMessageService : WearableListenerService() {
    override fun onMessageReceived(event: MessageEvent) {
        if (event.path != WatchLink.PATH_EPOCHS) return
        val json = String(event.data, Charsets.UTF_8)
        val batch = WatchBatchStore.accept(json) ?: return
        if (NightTracker.onWatchBatch(this, batch, System.currentTimeMillis())) NightService.stop(this)
    }
}
