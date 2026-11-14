// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import android.app.AlarmManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Re-arms the stored alarm (and resumes night tracking, where Android allows) after reboot, app update or a change of the exact-alarm permission. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED,
            -> {
                HardAlarm.holdBriefly(context)
                // Idempotent: LOCKED_BOOT_COMPLETED and BOOT_COMPLETED both arrive; setAlarmClock with the same
                // PendingIntent replaces the earlier one. An already rung alarm is marked FIRED and not re-rung.
                HardAlarm.rearm(context)
                // Tracking can only restart once the user data is unlocked (the service is not direct-boot aware),
                // and a locked-boot start would be repeated by BOOT_COMPLETED anyway.
                if (intent.action != Intent.ACTION_LOCKED_BOOT_COMPLETED) NightService.resumeIfTracking(context)
            }
        }
    }
}
