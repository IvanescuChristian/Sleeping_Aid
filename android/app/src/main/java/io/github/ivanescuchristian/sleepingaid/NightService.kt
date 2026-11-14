// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.ServiceCompat
import io.github.ivanescuchristian.sleepingaid.engine.EngineConfig

/**
 * Night tracking foreground service (type "health"): the native smart-wake engine's runtime.
 *
 * It feeds the phone accelerometer into [NightTracker] and ticks it, so smart wake works with the screen off,
 * the app in the background or the app swiped away. The exact backup alarm (AlarmManager, see HardAlarm) stays
 * the guarantee and does not depend on this service.
 *
 * CPU policy ("as needed", not 100% of the night):
 *  - Accelerometer events are requested with batching (up to [MAX_LATENCY_US]). Where the device has a
 *    wake-up accelerometer the sensor hub wakes the CPU only to deliver a batch, every ~20 s, and no wake lock
 *    is held at all; ingest and tick run synchronously inside the callback.
 *  - Without a wake-up sensor, non-wake-up events are lost while the CPU sleeps, so a bounded partial wake lock
 *    keeps it up until shortly after the window end. That is the only case where the CPU stays awake all night.
 *
 * START_STICKY: if Android kills the process the service comes back and resumes from the persisted epochs
 * (NightStore). After a reboot BootReceiver does the same where Android allows it.
 */
class NightService : Service(), SensorEventListener {
    private var wakeLock: PowerManager.WakeLock? = null
    private var sensors: SensorManager? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var started = false
    private var lastSampleT = 0L
    private var hzCount = 0
    private var hzSince = 0L

    private val ticker = object : Runnable {
        override fun run() {
            if (finishIfOver(NightTracker.tick(this@NightService, System.currentTimeMillis()))) return
            handler?.postDelayed(this, TICK_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // startForeground first: Android allows only a few seconds after startForegroundService.
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH
        } else {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST
        }
        try {
            ServiceCompat.startForeground(this, Notifications.ID_NIGHT, Notifications.night(this), type)
        } catch (_: Exception) {
            // A restart Android did not allow (background start limits): ask the user instead of failing silently.
            Notifications.postResumeTracking(this)
            stopSelf()
            return START_NOT_STICKY
        }
        val night = NightStore.load(this)
        val now = System.currentTimeMillis()
        if (night != null && night.state == NightStore.State.WOKE) {
            // Killed between persisting a smart decision and ringing: finish the ring, do not wait for the window end.
            HardAlarm.completeSmartWake(this)
        }
        if (night == null || night.state != NightStore.State.TRACKING) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (now >= night.windowEnd + EXPIRY_GRACE_MS) {
            NightStore.markEnded(this)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!started) {
            started = true
            running = true
            NightTracker.start(this, night, now)
            val t = HandlerThread("sleepaid-night").also { it.start() }
            thread = t
            handler = Handler(t.looper)
            registerSensor(night, now)
            handler?.postDelayed(ticker, TICK_MS)
        }
        return START_STICKY
    }

    private fun registerSensor(night: NightStore.Night, now: Long) {
        val sm = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        sensors = sm
        val wakeUp = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER, true)
        val sensor = wakeUp ?: sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        if (sensor != null) sm.registerListener(this, sensor, SAMPLE_PERIOD_US, MAX_LATENCY_US, handler)
        if (wakeUp == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            val hold = (night.windowEnd + WAKE_LOCK_TAIL_MS - now).coerceIn(60_000L, MAX_NIGHT_MS)
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sleepingaid:night").apply {
                setReferenceCounted(false)
                acquire(hold) // bounded: never held forever if the stop call is lost
            }
        }
    }

    override fun onSensorChanged(event: SensorEvent) {
        // Event time, not arrival time: batched events arrive late but carry their true timestamp.
        val now = System.currentTimeMillis()
        val t = now - SystemClock.elapsedRealtime() + event.timestamp / 1_000_000L
        if (t - lastSampleT < MIN_INTERVAL_MS) return
        lastSampleT = t
        hzCount++
        if (hzSince == 0L) hzSince = now
        if (now - hzSince >= 5_000) {
            NightTracker.motionHz = ((hzCount * 1000L) / (now - hzSince)).toInt()
            hzCount = 0
            hzSince = now
        }
        val v = event.values
        finishIfOver(NightTracker.onPhoneMotion(this, t, v[0].toDouble(), v[1].toDouble(), v[2].toDouble(), now))
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    /** The engine reached its decision (or the night ended): the alarm service has the stage now. */
    private fun finishIfOver(over: Boolean): Boolean {
        if (over) stopSelf()
        return over
    }

    override fun onDestroy() {
        running = false
        handler?.removeCallbacks(ticker)
        sensors?.unregisterListener(this)
        sensors = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        thread?.quitSafely()
        thread = null
        NightTracker.stop()
        super.onDestroy()
    }

    companion object {
        /** 10 Hz, same as the JavaScript motion limit. Well below the 200 Hz that needs no special permission. */
        private const val SAMPLE_PERIOD_US = 100_000
        private const val MIN_INTERVAL_MS = 90L // below the 100 ms period so sensor jitter does not thin 10 Hz to ~7 Hz

        /** Short enough that data stays "fresh" for the smart-wake rule (2 epochs), long enough to let the CPU sleep. */
        private val MAX_LATENCY_US = (EngineConfig.SENSOR_MAX_LATENCY_MS * 1000).toInt()
        private const val TICK_MS = 5_000L
        private const val MAX_NIGHT_MS = 14 * 60 * 60_000L
        private const val WAKE_LOCK_TAIL_MS = 10 * 60_000L

        /** A night this long past its window end is stale (the phone was off); do not resume it. */
        private const val EXPIRY_GRACE_MS = 3 * 60 * 60_000L

        /** True while the service of THIS process is running; false after a kill, which is how JS sees "needs resume". */
        @Volatile
        var running = false
            private set

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, NightService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, NightService::class.java))
        }

        /**
         * After a reboot or an update: restarts tracking for a night that was still running. Android may refuse
         * a foreground-service start from the background (Android 15 forbids several types from BOOT_COMPLETED;
         * "health" is not among them, but the start is still best effort), in which case the user gets a
         * "tap to resume" notification. The backup alarm is re-armed separately and does not wait for this.
         */
        fun resumeIfTracking(ctx: Context) {
            val n = NightStore.load(ctx) ?: return
            if (n.state != NightStore.State.TRACKING) return
            if (System.currentTimeMillis() >= n.windowEnd + EXPIRY_GRACE_MS) {
                NightStore.markEnded(ctx)
                return
            }
            try {
                start(ctx)
            } catch (_: Exception) {
                Notifications.postResumeTracking(ctx)
            }
        }
    }
}
