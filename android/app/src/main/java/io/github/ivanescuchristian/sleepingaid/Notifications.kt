// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** Channels and notification builders shared by the services and receivers. */
object Notifications {
    /** The ringing alarm. Silent channel: the service plays sound and vibration itself. */
    const val CHANNEL_ALARM = "alarm"

    /** Used only when the alarm service cannot start (for example blocked from a boot receiver). */
    const val CHANNEL_ALARM_FALLBACK = "alarm_fallback"
    const val CHANNEL_NIGHT = "night"
    const val CHANNEL_WARN = "warning"

    const val ID_ALARM = 1001
    const val ID_NIGHT = 1002
    const val ID_WARN = 1003
    const val ID_MISSED = 1004
    const val ID_RESUME = 1005

    fun alarmSound(): Uri? =
        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val alarmAttrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ALARM, "Alarm", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Shown while the alarm rings"
                setSound(null, null)
                enableVibration(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ALARM_FALLBACK, "Alarm (backup)", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Rings the alarm if the main alarm service cannot start"
                setSound(alarmSound(), alarmAttrs)
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 800, 500, 800, 500)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_NIGHT, "Night tracking", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while Sleeping Aid tracks your night"
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_WARN, "Alarm problems", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Shown when the alarm could not be armed"
            },
        )
    }

    private fun immutable() = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    private fun alarmScreenIntent(ctx: Context): PendingIntent =
        PendingIntent.getActivity(
            ctx, 10, Intent(ctx, AlarmActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), immutable(),
        )

    private fun serviceAction(ctx: Context, action: String, code: Int): PendingIntent =
        PendingIntent.getService(ctx, code, Intent(ctx, AlarmService::class.java).setAction(action), immutable())

    /** The ringing-alarm notification: full-screen intent to AlarmActivity plus Stop and Snooze actions. */
    fun ringing(ctx: Context, label: String, channel: String = CHANNEL_ALARM): Notification {
        ensureChannels(ctx)
        val screen = alarmScreenIntent(ctx)
        return NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(label.ifBlank { "Sleeping Aid" })
            .setContentText("Wake up")
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(screen)
            .setFullScreenIntent(screen, true)
            .addAction(0, "Stop", serviceAction(ctx, AlarmService.ACTION_STOP, 11))
            .addAction(0, "Snooze", serviceAction(ctx, AlarmService.ACTION_SNOOZE, 12))
            .build()
    }

    /** Backup path: a plain notification on the channel that has its own alarm sound. */
    fun postFallbackRinging(ctx: Context, label: String) {
        val n = ringing(ctx, label, CHANNEL_ALARM_FALLBACK).apply { flags = flags or Notification.FLAG_INSISTENT }
        notify(ctx, ID_ALARM, n)
    }

    fun night(ctx: Context): Notification {
        ensureChannels(ctx)
        val open = PendingIntent.getActivity(ctx, 20, Intent(ctx, MainActivity::class.java), immutable())
        return NotificationCompat.Builder(ctx, CHANNEL_NIGHT)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("Sleeping Aid")
            .setContentText("Tracking your night. The alarm is armed.")
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .build()
    }

    fun postNotArmed(ctx: Context) {
        ensureChannels(ctx)
        val open = PendingIntent.getActivity(ctx, 21, Intent(ctx, MainActivity::class.java), immutable())
        notify(
            ctx, ID_WARN,
            NotificationCompat.Builder(ctx, CHANNEL_WARN)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle("Alarm is NOT armed")
                .setContentText("Allow exact alarms for Sleeping Aid, then start the night again.")
                .setCategory(NotificationCompat.CATEGORY_ERROR)
                .setContentIntent(open)
                .setAutoCancel(true)
                .build(),
        )
    }

    /** Android did not allow tracking to restart on its own (for example after a reboot): one tap resumes it. */
    fun postResumeTracking(ctx: Context) {
        ensureChannels(ctx)
        val open = PendingIntent.getActivity(ctx, 22, Intent(ctx, MainActivity::class.java), immutable())
        notify(
            ctx, ID_RESUME,
            NotificationCompat.Builder(ctx, CHANNEL_WARN)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle("Tap to resume night tracking")
                .setContentText("Smart wake paused. The backup alarm is still set.")
                .setCategory(NotificationCompat.CATEGORY_ERROR)
                .setContentIntent(open)
                .setAutoCancel(true)
                .build(),
        )
    }

    fun postMissed(ctx: Context) {
        ensureChannels(ctx)
        notify(
            ctx, ID_MISSED,
            NotificationCompat.Builder(ctx, CHANNEL_WARN)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle("Missed alarm")
                .setContentText("The alarm rang for a long time and was silenced.")
                .setAutoCancel(true)
                .build(),
        )
    }

    fun cancel(ctx: Context, id: Int) = NotificationManagerCompat.from(ctx).cancel(id)

    @Suppress("MissingPermission") // Without POST_NOTIFICATIONS the call is a no-op; the services do not depend on it.
    private fun notify(ctx: Context, id: Int, n: Notification) {
        try {
            NotificationManagerCompat.from(ctx).notify(id, n)
        } catch (_: SecurityException) {
            // Notifications blocked: nothing else to do here.
        }
    }
}
