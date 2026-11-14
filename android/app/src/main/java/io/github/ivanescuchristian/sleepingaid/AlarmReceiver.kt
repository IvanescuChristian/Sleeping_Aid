// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Entry point of the hard alarm. Runs even when the app process (and the WebView) is dead. */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        HardAlarm.holdBriefly(context)
        HardAlarm.onFired(context)
    }
}
