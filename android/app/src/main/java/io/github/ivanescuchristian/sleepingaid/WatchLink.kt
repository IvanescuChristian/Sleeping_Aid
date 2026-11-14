// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid

import android.content.Context
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.Wearable

/**
 * Phone side of the Wear OS Data Layer. Watches are found through the capability the watch app advertises
 * (see the watch module's res/values/wear.xml), so only watches that really have the app installed are used.
 * Callbacks run on the main thread. MessageClient is best effort: "sent" means queued for the node.
 */
object WatchLink {
    const val PATH_EPOCHS = "/sleepaid/epochs"
    const val PATH_START = "/sleepaid/start"
    const val PATH_STOP = "/sleepaid/stop"
    const val CAP_WATCH = "sleepaid_watch"

    /** Connected watches that have the watch app. A null list means the Data Layer could not be queried. */
    fun watches(ctx: Context, cb: (List<Node>?) -> Unit) {
        try {
            Wearable.getCapabilityClient(ctx.applicationContext)
                .getCapability(CAP_WATCH, CapabilityClient.FILTER_REACHABLE)
                .addOnSuccessListener { cb(it.nodes.toList()) }
                .addOnFailureListener { cb(null) }
        } catch (_: Exception) {
            cb(null)
        }
    }

    /** Sends [path] to every reachable watch and reports how many sends were accepted. */
    fun send(ctx: Context, path: String, payload: ByteArray, cb: (sent: Int) -> Unit = {}) {
        watches(ctx) { nodes ->
            if (nodes.isNullOrEmpty()) {
                cb(0)
                return@watches
            }
            var outstanding = nodes.size
            var ok = 0
            for (node in nodes) {
                try {
                    Wearable.getMessageClient(ctx.applicationContext).sendMessage(node.id, path, payload)
                        .addOnSuccessListener { ok++ }
                        .addOnCompleteListener { if (--outstanding == 0) cb(ok) }
                } catch (_: Exception) {
                    if (--outstanding == 0) cb(ok)
                }
            }
        }
    }

    fun sendStart(ctx: Context, cb: (Int) -> Unit = {}) =
        send(ctx, PATH_START, "{\"v\":1,\"at\":${System.currentTimeMillis()}}".toByteArray(Charsets.UTF_8), cb)

    fun sendStop(ctx: Context, cb: (Int) -> Unit = {}) =
        send(ctx, PATH_STOP, "{\"v\":1,\"at\":${System.currentTimeMillis()}}".toByteArray(Charsets.UTF_8), cb)
}
