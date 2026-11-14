// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import android.content.Context

/**
 * The scheduled alarm, persisted so it can be re-armed after a reboot or an app update.
 *
 * Stored in device-protected storage: it is readable before the first unlock after a reboot
 * (LOCKED_BOOT_COMPLETED). It holds only a time and a label, nothing sensitive.
 */
object AlarmStore {
    enum class State {
        /** Scheduled with AlarmManager and not rung yet. */
        PENDING,

        /** Rang (or was triggered early). Kept so the WebView, when it wakes late, does not ring it again. */
        FIRED,
    }

    /**
     * [at] is when the alarm actually triggers (boot re-arm uses it); a smart wake moves it to "now". [windowEnd] is
     * the time the alarm was scheduled for and never changes, so "this alarm already rang" survives that move.
     * Records written before the field existed read it as [at].
     */
    data class Record(val at: Long, val label: String, val state: State, val windowEnd: Long = at) {
        /** True when the alarm scheduled for [scheduledFor] already rang: it must not be armed a second time. */
        fun alreadyFiredFor(scheduledFor: Long): Boolean = state == State.FIRED && windowEnd == scheduledFor
    }

    private const val FILE = "sleepaid_alarm"
    private const val K_AT = "at"
    private const val K_LABEL = "label"
    private const val K_STATE = "state"
    private const val K_WINDOW_END = "windowEnd"

    private fun prefs(ctx: Context) =
        ctx.createDeviceProtectedStorageContext().getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun load(ctx: Context): Record? {
        val p = prefs(ctx)
        if (!p.contains(K_AT)) return null
        val state = runCatching { State.valueOf(p.getString(K_STATE, "") ?: "") }.getOrNull() ?: return null
        val at = p.getLong(K_AT, 0L)
        return Record(at, p.getString(K_LABEL, "") ?: "", state, p.getLong(K_WINDOW_END, at))
    }

    fun save(ctx: Context, r: Record) {
        // commit(): the process may be killed right after; the record must already be on disk.
        prefs(ctx).edit().putLong(K_AT, r.at).putString(K_LABEL, r.label).putString(K_STATE, r.state.name)
            .putLong(K_WINDOW_END, r.windowEnd).commit()
    }

    fun clear(ctx: Context) {
        prefs(ctx).edit().clear().commit()
    }
}
