// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.view.WindowManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import io.github.ivanescuchristian.sleepingaid.engine.validateWindow

/** Bridge between the JavaScript app and the native hard alarm and night service. */
@CapacitorPlugin(
    name = "SleepAidNative",
    permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")],
)
class SleepAidNativePlugin : Plugin() {
    override fun load() {
        instance = this
    }

    override fun handleOnDestroy() {
        if (instance === this) instance = null
        super.handleOnDestroy()
    }

    /** Events are retained until JavaScript registers a listener, so one sent while the WebView starts is not lost. */
    private fun emit(event: String, data: JSObject) = notifyListeners(event, data, true)

    private fun permissionsJson(): JSObject {
        val ctx = context
        val fullScreen = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ctx.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
        } else {
            true
        }
        return JSObject()
            .put("exactAlarm", HardAlarm.canScheduleExact(ctx))
            .put("notifications", NotificationManagerCompat.from(ctx).areNotificationsEnabled())
            .put("fullScreenIntent", fullScreen)
    }

    @PluginMethod
    fun getAlarmPermissions(call: PluginCall) = call.resolve(permissionsJson())

    @PluginMethod
    fun scheduleHardAlarm(call: PluginCall) {
        val at = call.data.optLong("atEpochMs", 0L)
        if (at <= 0L) {
            call.reject("atEpochMs is required")
            return
        }
        val label = call.getString("label") ?: ""
        val result = HardAlarm.schedule(context, at, label)
        call.resolve(
            JSObject().put(
                "result",
                when (result) {
                    HardAlarm.ScheduleResult.SCHEDULED -> "scheduled"
                    HardAlarm.ScheduleResult.ALREADY_FIRED -> "already-fired"
                    HardAlarm.ScheduleResult.EXACT_DENIED -> "exact-alarm-denied"
                },
            ),
        )
    }

    @PluginMethod
    fun cancelHardAlarm(call: PluginCall) {
        HardAlarm.cancel(context)
        call.resolve()
    }

    @PluginMethod
    fun triggerWakeNow(call: PluginCall) {
        val result = HardAlarm.trigger(context)
        call.resolve(
            JSObject().put(
                "result",
                when (result) {
                    HardAlarm.TriggerResult.RANG -> "rang"
                    HardAlarm.TriggerResult.ALREADY_FIRED -> "already-fired"
                    HardAlarm.TriggerResult.NO_PENDING -> "no-pending"
                },
            ),
        )
    }

    /**
     * Native replacement for the unreliable Screen Wake Lock API in the WebView: while the night runs the
     * screen stays on at minimum brightness. Without it the page is hidden after about a minute and the
     * WebView throttles timers to one per minute, which starves the JavaScript smart-wake engine.
     * Window changes must happen on the UI thread.
     */
    @PluginMethod
    fun setNightScreen(call: PluginCall) {
        val on = call.getBoolean("on", false) == true
        val act = activity
        if (act == null) {
            call.reject("No activity")
            return
        }
        act.runOnUiThread {
            val w = act.window
            val lp = w.attributes
            if (on) {
                w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                lp.screenBrightness = NIGHT_BRIGHTNESS
            } else {
                w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            }
            w.attributes = lp
            call.resolve()
        }
    }

    /**
     * What the native alarm is doing: "none", "pending", "ringing" or "ended" (rang and was stopped, snoozed
     * alarms are "pending" again). Lets JavaScript drop an alarm screen whose alarm was already stopped natively.
     */
    @PluginMethod
    fun getAlarmState(call: PluginCall) {
        val r = AlarmStore.load(context)
        val state = when {
            r == null -> "none"
            r.state == AlarmStore.State.PENDING -> "pending"
            AlarmService.ringing -> "ringing"
            else -> "ended"
        }
        call.resolve(JSObject().put("state", state))
    }

    @PluginMethod
    fun openExactAlarmSettings(call: PluginCall) {
        val pkg = Uri.parse("package:${context.packageName}")
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkg)
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
        }
        launchSettings(call, intent)
    }

    @PluginMethod
    fun openFullScreenIntentSettings(call: PluginCall) {
        val pkg = Uri.parse("package:${context.packageName}")
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg)
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
        }
        launchSettings(call, intent)
    }

    private fun launchSettings(call: PluginCall, intent: Intent) {
        try {
            activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            call.resolve()
        } catch (e: Exception) {
            // A device without that screen: fall back to the generic app settings page.
            try {
                activity.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                call.resolve()
            } catch (e2: Exception) {
                call.reject("Cannot open settings: ${e2.message}")
            }
        }
    }

    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        val needed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState("notifications") != PermissionState.GRANTED
        if (!needed) {
            call.resolve(permissionsJson())
            return
        }
        requestPermissionForAlias("notifications", call, "notificationsResult")
    }

    @PermissionCallback
    private fun notificationsResult(call: PluginCall) = call.resolve(permissionsJson())

    /**
     * Starts (or resumes) the native night engine. The parameters are persisted, so the service can continue
     * after the process was killed. The same startedAt means "the same night": a repeat resumes it and never
     * restarts a night that already woke or ended (JavaScript's hard alarm may report "already fired").
     */
    @PluginMethod
    fun startNightService(call: PluginCall) {
        val windowStart = call.data.optLong("windowStart", 0L)
        val windowEnd = call.data.optLong("windowEnd", 0L)
        val startedAt = call.data.optLong("startedAt", 0L)
        if (windowStart <= 0L || windowEnd <= 0L || startedAt <= 0L) {
            call.reject("windowStart, windowEnd and startedAt are required")
            return
        }
        try {
            val existing = NightStore.load(context)
            if (existing != null && existing.startedAt == startedAt) {
                if (existing.state != NightStore.State.TRACKING) {
                    call.resolve(JSObject().put("started", false).put("state", stateWire(existing.state)))
                    return
                }
            } else {
                validateWindow(windowStart, windowEnd)
                NightStore.begin(
                    context,
                    NightStore.Night(
                        startedAt, windowStart, windowEnd,
                        call.getBoolean("useMotion", true) == true, call.getBoolean("useWatch", false) == true,
                        NightStore.State.TRACKING, null, 0L, null,
                    ),
                )
            }
            NightService.start(context)
            call.resolve(JSObject().put("started", true).put("state", "tracking"))
        } catch (e: Exception) {
            call.reject("Night service could not start: ${e.message}")
        }
    }

    /** Stops tracking (the user pressed Stop). The epochs stay readable until clearNight() or the next night. */
    @PluginMethod
    fun stopNightService(call: PluginCall) {
        NightStore.markEnded(context)
        NightService.stop(context)
        call.resolve()
    }

    /** Forgets the night's outcome and epochs: JavaScript calls it once the summary is saved, or on "delete all". */
    @PluginMethod
    fun clearNight(call: PluginCall) {
        NightService.stop(context)
        NightStore.clear(context)
        call.resolve()
    }

    private fun stateWire(s: NightStore.State) = when (s) {
        NightStore.State.TRACKING -> "tracking"
        NightStore.State.WOKE -> "woke"
        NightStore.State.ENDED -> "ended"
    }

    /**
     * Live status of the native engine. state: "none" | "tracking" | "woke" | "ended". needsResume: the night is
     * still being tracked in the store, but no service of this process runs it (killed, or not restarted after
     * a reboot): the app is in the foreground now, so JavaScript can start it again.
     */
    @PluginMethod
    fun getNightStatus(call: PluginCall) {
        val now = System.currentTimeMillis()
        val n = NightStore.load(context)
        if (n == null) {
            call.resolve(JSObject().put("state", "none"))
            return
        }
        val snap = NightTracker.snapshot(context, now)
        val out = JSObject()
            .put("state", stateWire(n.state))
            .put("startedAt", n.startedAt).put("windowStart", n.windowStart).put("windowEnd", n.windowEnd)
            .put("stage", snap.stage).put("epochs", snap.epochs).put("lastEpochAt", snap.lastEpochAt)
            .put("motionSource", snap.motionSource).put("motionHz", NightTracker.motionHz)
            .put("errors", snap.errors)
            .put("needsResume", n.state == NightStore.State.TRACKING && !NightService.running)
        if (snap.hrBpm != null) out.put("hrBpm", snap.hrBpm)
        if (n.state == NightStore.State.WOKE) {
            out.put("wake", JSObject().put("reason", n.wakeReason ?: "fallback").put("at", n.wakeAt).put("stage", n.wakeStage ?: "unknown"))
        }
        call.resolve(out)
    }

    /** Every epoch of the current night, oldest first, for the hypnogram and the summary. */
    @PluginMethod
    fun getNightEpochs(call: PluginCall) {
        val out = JSArray()
        NightStore.readEpochs(context).forEach {
            out.put(JSObject().put("start", it.result.start).put("stage", it.result.stage.wire).put("confidence", it.result.confidence))
        }
        call.resolve(JSObject().put("epochs", out))
    }

    // ---------- Wear OS watch ----------

    /** Asks the watch app to start recording. `reset` (a new night) also forgets batches of earlier nights. */
    @PluginMethod
    fun startWatch(call: PluginCall) {
        if (call.getBoolean("reset", false) == true) WatchBatchStore.clear(context)
        WatchLink.sendStart(context) { sent -> call.resolve(JSObject().put("sent", sent)) }
    }

    @PluginMethod
    fun stopWatch(call: PluginCall) {
        WatchLink.sendStop(context) { sent -> call.resolve(JSObject().put("sent", sent)) }
    }

    @PluginMethod
    fun getWatchStatus(call: PluginCall) {
        WatchLink.watches(context) { nodes ->
            val list = JSArray()
            nodes?.forEach { list.put(JSObject().put("id", it.id).put("name", it.displayName).put("nearby", it.isNearby)) }
            call.resolve(
                JSObject()
                    .put("available", nodes != null)
                    .put("connected", !nodes.isNullOrEmpty())
                    .put("nodes", list)
                    .put("lastEpochAt", WatchBatchStore.lastReceivedAt)
                    .put("lastSeq", WatchBatchStore.lastSeq)
                    .put("session", WatchBatchStore.lastSession ?: ""),
            )
        }
    }

    /** Legacy: the native engine consumes watch batches itself now, so there is never anything to drain. */
    @PluginMethod
    fun drainWatchEpochs(call: PluginCall) = call.resolve(JSObject().put("batches", JSArray()))

    companion object {
        /** Dim enough to sleep next to, above 0 because some devices treat 0 as "off" or ignore it. */
        private const val NIGHT_BRIGHTNESS = 0.01f

        @Volatile
        private var instance: SleepAidNativePlugin? = null

        /** [reason]: "stopped", "snoozed" or "missed". Called from AlarmService when the alarm ended on the native side. */
        fun emitAlarmEnded(reason: String) {
            instance?.emit("alarmEnded", JSObject().put("reason", reason).put("at", System.currentTimeMillis()))
        }
    }
}
