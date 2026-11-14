// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.ServiceCompat

/**
 * Owns the ringing alarm: looping system alarm sound, vibration, the notification (with the
 * full-screen intent to AlarmActivity) and a wake lock. Independent of the WebView.
 */
class AlarmService : Service() {
    private var player: MediaPlayer? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val handler = Handler(Looper.getMainLooper())
    private val giveUp = Runnable { stopRinging(Ended.MISSED) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_RING -> ring(intent.getStringExtra(EXTRA_LABEL).orEmpty())
            ACTION_STOP -> {
                stopRinging(Ended.STOPPED)
                // The alarm ended the night: the tracking service (and the watch) have nothing left to do.
                stopService(Intent(this, NightService::class.java))
                WatchLink.sendStop(this)
                WatchBatchStore.clear(this)
            }
            ACTION_SNOOZE -> snooze()
            else -> stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun ring(label: String) {
        // startForeground first: Android allows only a few seconds after startForegroundService.
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
        ServiceCompat.startForeground(this, Notifications.ID_ALARM, Notifications.ringing(this, label), type)
        if (ringing) return // a duplicate trigger (for example JS and AlarmManager together)
        ringing = true
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sleepingaid:ringing").apply {
            setReferenceCounted(false)
            acquire(MAX_RING_MS + 30_000L)
        }
        startSound()
        startVibration()
        handler.postDelayed(giveUp, MAX_RING_MS)
    }

    private fun startSound() {
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        // The default alarm sound first; the notification and ringtone sounds are backups if it cannot be opened
        // (for example it lives on storage that is still locked after a reboot).
        for (uri in listOfNotNull(
            android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_ALARM),
            android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION),
            android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE),
        )) {
            try {
                val p = MediaPlayer()
                p.setAudioAttributes(attrs)
                p.setDataSource(this, uri)
                p.isLooping = true
                p.prepare()
                p.start()
                player = p
                return
            } catch (_: Exception) {
                // try the next sound
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun startVibration() {
        val vib: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        if (vib == null || !vib.hasVibrator()) return
        val pattern = longArrayOf(0, 800, 600)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
            vib.vibrate(VibrationEffect.createWaveform(pattern, 0), attrs)
        } else {
            vib.vibrate(pattern, 0)
        }
    }

    private fun snooze() {
        val r = AlarmStore.load(this)
        val result = HardAlarm.schedule(this, System.currentTimeMillis() + SNOOZE_MS, r?.label.orEmpty())
        // Without the exact-alarm permission the snooze cannot be armed: keep ringing rather than lose the alarm.
        if (result == HardAlarm.ScheduleResult.SCHEDULED) stopRinging(Ended.SNOOZED)
    }

    private fun stopRinging(why: Ended) {
        handler.removeCallbacks(giveUp)
        cleanup()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        Notifications.cancel(this, Notifications.ID_ALARM)
        if (why == Ended.MISSED) Notifications.postMissed(this)
        // The JavaScript alarm screen (if there is one) must close too. Not sent when JavaScript itself
        // cancelled the alarm: that path ends in onDestroy, not here.
        SleepAidNativePlugin.emitAlarmEnded(why.wire)
        stopSelf()
    }

    private fun cleanup() {
        ringing = false
        try {
            player?.stop()
        } catch (_: IllegalStateException) {
            // never started
        }
        player?.release()
        player = null
        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION") getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }).cancel()
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        // Tell AlarmActivity (if shown) to close, for example after Stop from the notification.
        sendBroadcast(Intent(ACTION_ALARM_ENDED).setPackage(packageName))
    }

    override fun onDestroy() {
        handler.removeCallbacks(giveUp)
        if (ringing || player != null) cleanup()
        super.onDestroy()
    }

    /** How a ringing alarm ended from the native side; the wire value goes to JavaScript. */
    private enum class Ended(val wire: String) { STOPPED("stopped"), SNOOZED("snoozed"), MISSED("missed") }

    companion object {
        const val ACTION_RING = "io.github.ivanescuchristian.sleepingaid.RING"
        const val ACTION_STOP = "io.github.ivanescuchristian.sleepingaid.STOP"
        const val ACTION_SNOOZE = "io.github.ivanescuchristian.sleepingaid.SNOOZE"
        const val ACTION_ALARM_ENDED = "io.github.ivanescuchristian.sleepingaid.ALARM_ENDED"
        private const val EXTRA_LABEL = "label"
        const val SNOOZE_MS = 9 * 60_000L

        /** A ringing alarm nobody answers is silenced after this long. */
        private const val MAX_RING_MS = 15 * 60_000L

        @Volatile
        var ringing = false
            private set

        /** Starts ringing. If the foreground service cannot start, falls back to a notification with alarm sound. */
        fun ring(ctx: Context, label: String) {
            try {
                ctx.startForegroundService(Intent(ctx, AlarmService::class.java).setAction(ACTION_RING).putExtra(EXTRA_LABEL, label))
            } catch (_: Exception) {
                Notifications.postFallbackRinging(ctx, label)
            }
        }

        /** Stops a ringing alarm (and removes the backup notification). Safe when nothing rings. */
        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, AlarmService::class.java))
            Notifications.cancel(ctx, Notifications.ID_ALARM)
        }
    }
}
