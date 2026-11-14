// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.wear

import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService

/** Receives the phone's start and stop messages. */
class CommandService : WearableListenerService() {
    override fun onMessageReceived(event: MessageEvent) {
        when (event.path) {
            Protocol.PATH_START -> requestStart()
            Protocol.PATH_STOP -> {
                Notifications.cancelPrompt(this)
                TrackingService.stop(this)
            }
        }
    }

    private fun requestStart() {
        if (WatchState.running) return
        if (TrackingService.hasBodySensors(this)) {
            try {
                TrackingService.start(this)
                return
            } catch (_: Exception) {
                // Android refused a foreground-service start from the background: ask for a tap instead.
            }
        }
        Notifications.postTapToStart(this)
    }
}
