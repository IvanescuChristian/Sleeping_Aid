// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.wear

import android.Manifest
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.health.services.client.ExerciseClient
import androidx.health.services.client.ExerciseUpdateCallback
import androidx.health.services.client.HealthServices
import androidx.health.services.client.data.Availability
import androidx.health.services.client.data.BatchingMode
import androidx.health.services.client.data.DataType
import androidx.health.services.client.data.ExerciseConfig
import androidx.health.services.client.data.ExerciseLapSummary
import androidx.health.services.client.data.ExerciseTrackedStatus
import androidx.health.services.client.data.ExerciseType
import androidx.health.services.client.data.ExerciseUpdate
import androidx.health.services.client.data.HeartRateAccuracy
import java.io.File
import java.time.Instant
import java.util.UUID

/**
 * One night of tracking (foreground service, type "health").
 *
 * - Heart rate: an ExerciseClient session (the supported way to get continuous heart rate while the screen is
 *   off), heart rate only, no GPS, no auto-pause, 5 s batching when the watch supports it.
 * - Motion: the accelerometer, aggregated to one activity value per 30 s epoch ([ActivityAccumulator]).
 * - Delivery: a numbered batch to the phone each time an epoch closes (about every 30 s), unsent batches are
 *   kept ([PendingStore]) and retried on every tick.
 *
 * Everything runs on the main thread (sensor callbacks, Health Services callbacks and the timer share one
 * Handler or main executor), so no locking is needed.
 */
class TrackingService : Service(), SensorEventListener {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var link: PhoneLink
    private lateinit var store: PendingStore
    private val acc = ActivityAccumulator()
    private var builder = BatchBuilder("")
    private var sensors: SensorManager? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var exercise: ExerciseClient? = null
    private var exerciseCallback: ExerciseUpdateCallback? = null
    private var startedElapsed = 0L
    private var lastAccelAt = 0L
    private var lastFlushAt = 0L
    private val inFlight = HashSet<Long>()
    private var running = false
    private var phoneWasFound: Boolean? = null
    private var lastExerciseState: Any? = null

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            flush(force = false)
            handler.postDelayed(this, TICK_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        // Foreground first, before any other work: Android allows only a few seconds after startForegroundService.
        try {
            ServiceCompat.startForeground(
                this, Notifications.ID_TRACKING, Notifications.tracking(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH,
            )
        } catch (e: Exception) {
            // Typically a missing body-sensor permission, or a start that Android does not allow from the background.
            Log.w(TAG, "startForeground failed", e)
            WatchState.error = "Cannot start: ${e.message}"
            // Without a foreground start there is nothing to run: leave the user a one-tap way to start from the watch.
            Notifications.postTapToStart(this)
            stopSelf()
            return START_NOT_STICKY
        }
        if (running) return START_NOT_STICKY // a repeated start from the phone is a no-op
        running = true
        link = PhoneLink(this)
        store = PendingStore(File(filesDir, "pending.tsv"))
        store.clear() // leftovers of an earlier night are of no use
        builder = BatchBuilder(UUID.randomUUID().toString().take(8))
        startedElapsed = SystemClock.elapsedRealtime()
        lastFlushAt = startedElapsed
        WatchState.apply {
            running = true
            startedAtMs = System.currentTimeMillis()
            hrNow = null
            hrAtMs = 0
            batchesSent = 0
            batchesPending = 0
            phoneConnected = null
            error = null
        }
        Log.i(TAG, "tracking started")
        startAccelerometer()
        startExercise()
        handler.postDelayed(tick, TICK_MS)
        return START_NOT_STICKY // a killed night is restarted by the phone or by the user, not by a blind restart
    }

    // ---------- Accelerometer ----------

    private fun startAccelerometer() {
        val sm = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        sensors = sm
        // The wake-up variant lets the CPU sleep between deliveries; events are batched in the sensor hub.
        val sensor = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER, true) ?: sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        if (sensor == null) {
            Log.w(TAG, "no accelerometer")
            WatchState.error = "This watch has no accelerometer"
            return
        }
        if (!sensor.isWakeUpSensor) {
            // A non-wake-up sensor delivers nothing while the CPU sleeps, so keep it awake (bounded).
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sleepingaid:watch").apply {
                setReferenceCounted(false)
                acquire(Protocol.MAX_RUN_MS)
            }
        }
        sm.registerListener(this, sensor, SAMPLE_PERIOD_US, MAX_LATENCY_US, handler)
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (!running || event.values.size < 3) return
        val wall = bootWallMs() + event.timestamp / 1_000_000L
        lastAccelAt = SystemClock.elapsedRealtime()
        acc.add(wall, event.values[0].toDouble(), event.values[1].toDouble(), event.values[2].toDouble())
        if (acc.hasClosed) flush(force = false)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    // ---------- Heart rate (Health Services) ----------

    private fun startExercise() {
        val client = HealthServices.getClient(this).exerciseClient
        exercise = client
        val executor = ContextCompat.getMainExecutor(this)
        val callback = object : ExerciseUpdateCallback {
            override fun onRegistered() = Unit
            override fun onRegistrationFailed(throwable: Throwable) {
                Log.w(TAG, "exercise callback registration failed", throwable)
                WatchState.error = "Heart rate: ${throwable.message}"
            }

            override fun onExerciseUpdateReceived(update: ExerciseUpdate) = onExerciseUpdate(update)
            override fun onLapSummaryReceived(lapSummary: ExerciseLapSummary) = Unit
            override fun onAvailabilityChanged(dataType: DataType<*, *>, availability: Availability) {
                Log.i(TAG, "availability $dataType: $availability")
            }
        }
        exerciseCallback = callback
        client.setUpdateCallback(executor, callback)
        val infoFuture = client.getCurrentExerciseInfoAsync()
        infoFuture.addListener({
            try {
                val info = infoFuture.get()
                when (info.exerciseTrackedStatus) {
                    ExerciseTrackedStatus.OTHER_APP_IN_PROGRESS -> {
                        Log.w(TAG, "another app owns the exercise")
                        WatchState.error = "Another app is recording a workout: no heart rate"
                        return@addListener
                    }
                    // Left over from a killed service of ours: end it, then start a clean one.
                    ExerciseTrackedStatus.OWNED_EXERCISE_IN_PROGRESS -> {
                        Log.i(TAG, "ending a leftover exercise of ours")
                        client.endExerciseAsync().addListener({ configureAndStart(client, executor) }, executor)
                    }
                    else -> configureAndStart(client, executor)
                }
            } catch (e: Exception) {
                Log.w(TAG, "exercise info failed", e)
                WatchState.error = "Heart rate: ${e.message}"
            }
        }, executor)
    }

    private fun configureAndStart(client: ExerciseClient, executor: java.util.concurrent.Executor) {
        val capsFuture = client.getCapabilitiesAsync()
        capsFuture.addListener({
            try {
                val caps = capsFuture.get()
                val type = pickExerciseType(caps.typeToCapabilities.mapValues { it.value.supportedDataTypes })
                if (type == null) {
                    Log.w(TAG, "no exercise type with heart rate")
                    WatchState.error = "This watch cannot record heart rate in the background"
                    return@addListener
                }
                val batching = if (BatchingMode.HEART_RATE_5_SECONDS in caps.supportedBatchingModeOverrides) {
                    setOf(BatchingMode.HEART_RATE_5_SECONDS)
                } else {
                    emptySet()
                }
                WatchState.exerciseType = type.toString()
                Log.i(TAG, "exercise type $type, HEART_RATE_5_SECONDS batching " +
                    if (batching.isEmpty()) "not supported (not applied)" else "supported (applied)")
                val config = ExerciseConfig.builder(type)
                    .setDataTypes(setOf(DataType.HEART_RATE_BPM))
                    .setIsAutoPauseAndResumeEnabled(false)
                    .setIsGpsEnabled(false)
                    .setBatchingModeOverrides(batching)
                    .build()
                val started = client.startExerciseAsync(config)
                started.addListener({
                    try {
                        started.get()
                        Log.i(TAG, "exercise started")
                    } catch (e: Exception) {
                        Log.w(TAG, "exercise start failed", e)
                        WatchState.error = "Heart rate: ${e.cause?.message ?: e.message}"
                    }
                }, executor)
            } catch (e: Exception) {
                Log.w(TAG, "exercise configure failed", e)
                WatchState.error = "Heart rate: ${e.message}"
            }
        }, executor)
    }

    private fun onExerciseUpdate(update: ExerciseUpdate) {
        if (!running) return
        val state = update.exerciseStateInfo.state
        if (state != lastExerciseState) {
            Log.i(TAG, "exercise state $state")
            lastExerciseState = state
        }
        if (state.isEnded) {
            WatchState.error = "The heart-rate session ended (another app may have started a workout)"
            return
        }
        val boot = Instant.ofEpochMilli(bootWallMs())
        for (p in update.latestMetrics.getData(DataType.HEART_RATE_BPM)) {
            val status = (p.accuracy as? HeartRateAccuracy)?.sensorStatus
            if (status == HeartRateAccuracy.SensorStatus.NO_CONTACT || status == HeartRateAccuracy.SensorStatus.UNRELIABLE) continue
            val bpm = p.value
            if (!bpm.isFinite() || bpm < 20.0 || bpm > 250.0) continue
            val t = p.getTimeInstant(boot).toEpochMilli()
            builder.addHr(t, bpm)
            if (t >= WatchState.hrAtMs) {
                WatchState.hrNow = bpm
                WatchState.hrAtMs = t
            }
        }
    }

    // ---------- Batches and sending ----------

    /**
     * Builds the next batch (when an epoch closed, or at the latest once a minute) and tries to send every
     * unsent one, oldest first.
     */
    private fun flush(force: Boolean) {
        val nowElapsed = SystemClock.elapsedRealtime()
        if (nowElapsed - startedElapsed > Protocol.MAX_RUN_MS) {
            stopSelf()
            return
        }
        val epochs = if (acc.hasClosed) acc.takeClosed() else emptyList()
        val due = epochs.isNotEmpty() || force || nowElapsed - lastFlushAt >= HEARTBEAT_MS
        if (due) {
            val now = System.currentTimeMillis()
            val accelAlive = nowElapsed - lastAccelAt < ACCEL_ALIVE_MS && lastAccelAt != 0L
            val covered = if (accelAlive) acc.lastClosedEnd else now
            builder.build(epochs, covered, now)?.let { (seq, json) -> store.add(seq, json) }
            lastFlushAt = nowElapsed
        }
        sendPending()
    }

    private fun sendPending() {
        val items = store.snapshot()
        WatchState.batchesPending = items.size
        link.phones { nodes ->
            WatchState.phoneConnected = !nodes.isNullOrEmpty()
            if (nodes.isNullOrEmpty()) {
                if (phoneWasFound != false) Log.i(TAG, "phone node not found")
                phoneWasFound = false
                return@phones
            }
            if (phoneWasFound != true) Log.i(TAG, "phone node found (${nodes.size})")
            phoneWasFound = true
            for ((seq, json) in store.snapshot().take(MAX_PER_TICK)) {
                if (!inFlight.add(seq)) continue
                val bytes = json.toByteArray(Charsets.UTF_8)
                var outstanding = nodes.size
                var delivered = false
                for (node in nodes) {
                    link.send(node.id, Protocol.PATH_EPOCHS, bytes) { ok ->
                        delivered = delivered || ok
                        if (--outstanding == 0) {
                            inFlight.remove(seq)
                            if (delivered) {
                                store.remove(seq)
                                WatchState.batchesSent++
                            }
                            WatchState.batchesPending = store.size
                            if (delivered) Log.i(TAG, "batch $seq sent, ${store.size} pending")
                            else Log.w(TAG, "batch $seq send failed, ${store.size} pending")
                        }
                    }
                }
            }
        }
    }

    private fun bootWallMs(): Long = System.currentTimeMillis() - SystemClock.elapsedRealtime()

    override fun onDestroy() {
        if (running) {
            // One last attempt to hand over what is already built.
            runCatching { flush(force = true) }
            running = false
            handler.removeCallbacksAndMessages(null)
            sensors?.unregisterListener(this)
            sensors = null
            // End first, clear the callback after: clearing first would drop the final "ended" update.
            // Neither call is awaited, so onDestroy stays non-blocking.
            exercise?.let { client ->
                client.endExerciseAsync()
                exerciseCallback?.let { client.clearUpdateCallbackAsync(it) }
            }
            Log.i(TAG, "tracking stopped")
            exercise = null
            wakeLock?.let { if (it.isHeld) it.release() }
            wakeLock = null
            WatchState.running = false
        }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "SleepAidWatch"
        const val ACTION_STOP = "io.github.ivanescuchristian.sleepingaid.wear.STOP"

        /** 10 Hz, same as the phone. */
        private const val SAMPLE_PERIOD_US = 100_000

        /** The sensor hub may hold events this long before waking the CPU. */
        private const val MAX_LATENCY_US = 10_000_000
        private const val TICK_MS = 30_000L
        private const val HEARTBEAT_MS = 60_000L
        private const val ACCEL_ALIVE_MS = 60_000L
        private const val MAX_PER_TICK = 20

        /** Types, in order of preference, that do not look like a hard workout; the first the watch supports with heart rate wins. */
        private val PREFERRED = listOf(ExerciseType.MEDITATION, ExerciseType.UNKNOWN, ExerciseType.YOGA, ExerciseType.STRETCHING)

        fun pickExerciseType(supported: Map<ExerciseType, Set<DataType<*, *>>>): ExerciseType? {
            val withHr = supported.filterValues { DataType.HEART_RATE_BPM in it }.keys
            return PREFERRED.firstOrNull { it in withHr } ?: withHr.firstOrNull()
        }

        fun hasBodySensors(ctx: Context) =
            ctx.checkSelfPermission(Manifest.permission.BODY_SENSORS) == PackageManager.PERMISSION_GRANTED

        fun start(ctx: Context) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, TrackingService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, TrackingService::class.java))
        }
    }
}
