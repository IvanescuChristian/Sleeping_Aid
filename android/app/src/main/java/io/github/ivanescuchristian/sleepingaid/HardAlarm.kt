// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager

/** Schedules, cancels and fires the hard fallback alarm. Everything here works without the WebView. */
object HardAlarm {
    enum class ScheduleResult { SCHEDULED, ALREADY_FIRED, EXACT_DENIED }
    enum class TriggerResult { RANG, ALREADY_FIRED, NO_PENDING }

    /** A missed alarm older than this (phone was off) is dropped instead of ringing at boot. */
    private const val STALE_MS = 3 * 60 * 60_000L
    /** Long enough for the alarm manager to accept the time, short enough to feel immediate. */
    private const val FIRE_NOW_DELAY_MS = 1_000L
    private const val REQ_FIRE = 4101
    private const val REQ_SHOW = 4102

    private fun alarmManager(ctx: Context) = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    fun canScheduleExact(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager(ctx).canScheduleExactAlarms()

    private fun firePendingIntent(ctx: Context): PendingIntent =
        PendingIntent.getBroadcast(
            ctx, REQ_FIRE, Intent(ctx, AlarmReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /** Tapping the alarm icon in the system UI opens the app. */
    private fun showPendingIntent(ctx: Context): PendingIntent =
        PendingIntent.getActivity(
            ctx, REQ_SHOW, Intent(ctx, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /**
     * Arms the alarm. Never falls back to an inexact alarm: without the exact-alarm permission it
     * returns EXACT_DENIED and stores nothing, so the caller can tell the user.
     */
    fun schedule(ctx: Context, atEpochMs: Long, label: String): ScheduleResult {
        val existing = AlarmStore.load(ctx)
        // The same alarm already rang (and may have been stopped): never ring it a second time.
        if (existing != null && existing.alreadyFiredFor(atEpochMs)) {
            return ScheduleResult.ALREADY_FIRED
        }
        if (!canScheduleExact(ctx)) return ScheduleResult.EXACT_DENIED
        armAlarmManager(ctx, atEpochMs)
        AlarmStore.save(ctx, AlarmStore.Record(atEpochMs, label, AlarmStore.State.PENDING))
        return ScheduleResult.SCHEDULED
    }

    private fun armAlarmManager(ctx: Context, atEpochMs: Long) {
        alarmManager(ctx).setAlarmClock(
            AlarmManager.AlarmClockInfo(atEpochMs, showPendingIntent(ctx)),
            firePendingIntent(ctx),
        )
    }

    /** Cancels the pending alarm, stops a ringing one and forgets the record. */
    fun cancel(ctx: Context) {
        alarmManager(ctx).cancel(firePendingIntent(ctx))
        AlarmStore.clear(ctx)
        AlarmService.stop(ctx)
    }

    /** Smart wake from JS: ring now instead of at the stored time. Only a pending alarm rings. */
    fun trigger(ctx: Context): TriggerResult {
        val r = AlarmStore.load(ctx) ?: return TriggerResult.NO_PENDING
        if (r.state == AlarmStore.State.FIRED) return TriggerResult.ALREADY_FIRED
        alarmManager(ctx).cancel(firePendingIntent(ctx))
        AlarmStore.save(ctx, r.copy(state = AlarmStore.State.FIRED))
        AlarmService.ring(ctx, r.label)
        return TriggerResult.RANG
    }

    /**
     * Smart wake from the native engine: rings the SAME alarm now, through the same receiver as the backup.
     *
     * WHY re-arm instead of calling AlarmService.ring directly: the engine runs in the night service, with no
     * visible window, and a foreground-service start from there is not guaranteed to be allowed (Android 12+
     * background-start limits). An alarm-clock alarm is exempt by design, so it is also what the backup relies
     * on. Re-arming the one PendingIntent replaces the window-end alarm in the same step, so exactly one ring happens.
     */
    fun fireNow(ctx: Context): Boolean {
        val r = AlarmStore.load(ctx) ?: return false
        if (r.state == AlarmStore.State.FIRED) return false
        if (!canScheduleExact(ctx)) return trigger(ctx) == TriggerResult.RANG
        val at = System.currentTimeMillis() + FIRE_NOW_DELAY_MS
        // Stored too: a reboot within this second re-arms (and rings) from the record, not at the old window end.
        AlarmStore.save(ctx, r.copy(at = at))
        armAlarmManager(ctx, at)
        return true
    }

    /** The process died after a smart decision was persisted but before the ring: ring now if it has not rung. */
    fun completeSmartWake(ctx: Context) {
        val n = NightStore.load(ctx) ?: return
        if (n.state == NightStore.State.WOKE && n.wakeReason == "smart") fireNow(ctx)
    }

    /** AlarmManager fired. Rings unless the same alarm already rang through trigger(). */
    fun onFired(ctx: Context) {
        val r = AlarmStore.load(ctx)
        if (r != null && r.state == AlarmStore.State.FIRED) return
        // The night's reason: a no-op when the engine already recorded a smart wake (or a fallback decision).
        NightTracker.onBackupRang(ctx, System.currentTimeMillis())
        NightService.stop(ctx)
        AlarmStore.save(ctx, (r ?: AlarmStore.Record(System.currentTimeMillis(), "", AlarmStore.State.PENDING)).copy(state = AlarmStore.State.FIRED))
        AlarmService.ring(ctx, r?.label.orEmpty())
    }

    /** After reboot, app update or permission change: puts a stored pending alarm back into AlarmManager. */
    fun rearm(ctx: Context) {
        val r = AlarmStore.load(ctx) ?: return
        if (r.state != AlarmStore.State.PENDING) return
        val now = System.currentTimeMillis()
        if (r.at <= now) {
            if (now - r.at < STALE_MS) {
                AlarmStore.save(ctx, r.copy(state = AlarmStore.State.FIRED))
                AlarmService.ring(ctx, r.label)
            } else {
                AlarmStore.clear(ctx)
            }
            return
        }
        if (canScheduleExact(ctx)) {
            armAlarmManager(ctx, r.at)
        } else {
            // Not armed, and not silently downgraded: tell the user to allow exact alarms.
            Notifications.postNotArmed(ctx)
        }
    }

    /** Short partial wake lock so the CPU stays up from the broadcast until the service has started. */
    fun holdBriefly(ctx: Context, ms: Long = 20_000L) {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sleepingaid:alarm-start").apply {
            setReferenceCounted(false)
            acquire(ms)
        }
    }
}
