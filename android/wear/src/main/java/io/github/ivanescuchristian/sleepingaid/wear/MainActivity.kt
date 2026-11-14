// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.wear

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * The only screen: Start / Stop, and a few status lines. Plain Views keep the APK small (no Compose).
 * Permissions are asked here, in a visible activity, so a later start from the phone can run without a prompt.
 */
class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var status: TextView
    private lateinit var toggle: Button
    private lateinit var exerciseLine: TextView
    private lateinit var link: PhoneLink
    private var phoneSeen: Boolean? = null
    private var pendingStart = false

    private val refresh = object : Runnable {
        override fun run() {
            render()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        link = PhoneLink(this)
        setContentView(buildUi())
        if (intent?.getBooleanExtra(EXTRA_AUTOSTART, false) == true) beginStart()
    }

    override fun onResume() {
        super.onResume()
        link.phones { phoneSeen = !it.isNullOrEmpty() }
        handler.post(refresh)
    }

    override fun onPause() {
        handler.removeCallbacks(refresh)
        super.onPause()
    }

    private fun buildUi(): ScrollView {
        val pad = (20 * resources.displayMetrics.density).toInt()
        fun text(size: Float, bold: Boolean = false) = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = size
            gravity = Gravity.CENTER
            if (bold) typeface = Typeface.DEFAULT_BOLD
        }
        status = text(14f)
        // Small, because it is only a diagnostic for which Health Services exercise type is in use.
        exerciseLine = text(10f).apply { setTextColor(Color.LTGRAY) }
        toggle = Button(this).apply {
            isAllCaps = false
            setOnClickListener { if (WatchState.running) TrackingService.stop(this@MainActivity) else beginStart() }
        }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(pad, pad, pad, pad * 2)
            addView(text(16f, bold = true).apply { this.text = "Sleeping Aid" })
            addView(status)
            addView(exerciseLine)
            addView(toggle, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        return ScrollView(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(column)
        }
    }

    private fun render() {
        val s = WatchState
        val phone = if (s.running) s.phoneConnected else phoneSeen
        val lines = ArrayList<String>()
        if (s.running) {
            val hr = s.hrNow
            val age = if (s.hrAtMs > 0) (System.currentTimeMillis() - s.hrAtMs) / 1000 else -1
            lines += if (hr != null && age in 0..180) "Heart rate: ${hr.toInt()} bpm" else "Heart rate: waiting"
            lines += "Sent to phone: ${s.batchesSent}" + if (s.batchesPending > 0) " (${s.batchesPending} waiting)" else ""
        } else {
            lines += "Not recording"
        }
        lines += "Phone: " + when (phone) {
            true -> "connected"
            false -> "not connected"
            null -> "checking"
        }
        s.error?.let { lines += it }
        // Persistent: without background access the phone cannot start a night while the watch screen is off.
        if (backgroundDenied()) lines += "Background sensor access off: start nights from the watch"
        exerciseLine.text = if (s.running) s.exerciseType?.let { "Exercise type: $it" } ?: "" else ""
        status.text = lines.joinToString("\n")
        toggle.text = if (s.running) "Stop" else "Start night"
    }

    // ---------- Permissions, then start ----------

    private fun beginStart() {
        pendingStart = true
        val missing = REQUESTED.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            requestPermissions(missing.toTypedArray(), REQ_MAIN)
        } else {
            askBackgroundThenStart()
        }
    }

    /** Android asks for "all the time" body-sensor access separately, and only after the foreground grant. */
    private fun askBackgroundThenStart() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.BODY_SENSORS_BACKGROUND) != PackageManager.PERMISSION_GRANTED &&
            checkSelfPermission(Manifest.permission.BODY_SENSORS) == PackageManager.PERMISSION_GRANTED
        ) {
            // This permission opens a settings page, not a dialog, so say what to pick before sending the user there.
            AlertDialog.Builder(this)
                .setMessage("Choose \"All the time\" so the phone can start tracking while the watch screen is off, then press Back.")
                .setCancelable(false)
                .setPositiveButton("OK") { _, _ ->
                    requestPermissions(arrayOf(Manifest.permission.BODY_SENSORS_BACKGROUND), REQ_BACKGROUND)
                }
                .show()
        } else {
            startNow()
        }
    }

    @Deprecated("Fine for a single plain Activity.")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (!pendingStart) return
        if (requestCode == REQ_MAIN) askBackgroundThenStart() else startNow()
    }

    private fun backgroundDenied() = Build.VERSION.SDK_INT >= 33 &&
        checkSelfPermission(Manifest.permission.BODY_SENSORS_BACKGROUND) != PackageManager.PERMISSION_GRANTED

    private fun startNow() {
        pendingStart = false
        if (!TrackingService.hasBodySensors(this)) {
            WatchState.error = "Allow body sensors to record heart rate"
            return
        }
        Notifications.cancelPrompt(this)
        try {
            TrackingService.start(this)
        } catch (e: Exception) {
            WatchState.error = "Cannot start: ${e.message}"
        }
    }

    companion object {
        const val EXTRA_AUTOSTART = "autostart"
        private const val REQ_MAIN = 1
        private const val REQ_BACKGROUND = 2
        private val REQUESTED: List<String> = buildList {
            add(Manifest.permission.BODY_SENSORS)
            add(Manifest.permission.ACTIVITY_RECOGNITION)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
