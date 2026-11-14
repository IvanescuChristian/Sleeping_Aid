// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextClock
import android.widget.TextView
import androidx.core.content.ContextCompat

/** Native alarm screen shown over the lock screen. Talks to AlarmService only. */
class AlarmActivity : Activity() {
    private val ended = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(buildUi())
        ContextCompat.registerReceiver(
            this, ended, IntentFilter(AlarmService.ACTION_ALARM_ENDED), ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }

    override fun onResume() {
        super.onResume()
        // Opened late (for example from a stale notification): nothing is ringing any more.
        if (!AlarmService.ringing) finish()
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(ended) }
        super.onDestroy()
    }

    @Deprecated("The alarm must be answered with the buttons.")
    override fun onBackPressed() {
        // Ignored on purpose: Stop or Snooze must be chosen.
    }

    private fun send(action: String) {
        startService(Intent(this, AlarmService::class.java).setAction(action))
        if (action == AlarmService.ACTION_STOP) finish()
    }

    private fun buildUi(): LinearLayout {
        val pad = (24 * resources.displayMetrics.density).toInt()
        fun button(text: String, onClick: () -> Unit) = Button(this).apply {
            this.text = text
            textSize = 24f
            isAllCaps = false
            minHeight = (88 * resources.displayMetrics.density).toInt()
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                .apply { topMargin = pad }
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.BLACK)
            setPadding(pad, pad, pad, pad)
            addView(TextView(this@AlarmActivity).apply {
                text = "Wake up"
                setTextColor(Color.WHITE)
                textSize = 36f
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
            })
            addView(TextClock(this@AlarmActivity).apply {
                setTextColor(Color.WHITE)
                textSize = 64f
                format24Hour = "HH:mm"
                format12Hour = "HH:mm"
                gravity = Gravity.CENTER
            })
            addView(button("Stop") { send(AlarmService.ACTION_STOP) })
            addView(button("Snooze 9 min") { send(AlarmService.ACTION_SNOOZE) })
        }
    }
}
