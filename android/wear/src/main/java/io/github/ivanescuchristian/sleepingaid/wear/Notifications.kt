// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.wear

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object Notifications {
    private const val CHANNEL_TRACKING = "tracking"
    private const val CHANNEL_PROMPT = "prompt"
    const val ID_TRACKING = 2001
    private const val ID_PROMPT = 2002

    private fun ensureChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_TRACKING, "Night tracking", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while the watch records your night for the phone"
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_PROMPT, "Start request", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Shown when the phone asks to start tracking but the watch needs a tap"
            },
        )
    }

    private fun immutable() = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    fun tracking(ctx: Context): Notification {
        ensureChannels(ctx)
        val open = PendingIntent.getActivity(ctx, 1, Intent(ctx, MainActivity::class.java), immutable())
        val stop = PendingIntent.getService(
            ctx, 2, Intent(ctx, TrackingService::class.java).setAction(TrackingService.ACTION_STOP), immutable(),
        )
        return NotificationCompat.Builder(ctx, CHANNEL_TRACKING)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Sleeping Aid")
            .setContentText("Recording for the phone")
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .addAction(0, "Stop", stop)
            .build()
    }

    /** The phone asked to start but Android did not let a background start through: one tap on the watch does it. */
    fun postTapToStart(ctx: Context) {
        ensureChannels(ctx)
        val tap = PendingIntent.getActivity(
            ctx, 3, Intent(ctx, MainActivity::class.java).putExtra(MainActivity.EXTRA_AUTOSTART, true), immutable(),
        )
        val n = NotificationCompat.Builder(ctx, CHANNEL_PROMPT)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Sleeping Aid")
            .setContentText("Tap to start tracking for the phone")
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build()
        try {
            NotificationManagerCompat.from(ctx).notify(ID_PROMPT, n)
        } catch (_: SecurityException) {
            // Notifications not allowed: the user can still open the app and tap Start.
        }
    }

    fun cancelPrompt(ctx: Context) = NotificationManagerCompat.from(ctx).cancel(ID_PROMPT)
}
