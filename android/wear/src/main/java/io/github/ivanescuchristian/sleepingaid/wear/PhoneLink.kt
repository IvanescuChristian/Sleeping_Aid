// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.wear

import android.content.Context
import android.util.Log
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.Wearable

private const val TAG = "SleepAidWatch"

/** Thin, callback-style wrapper over the Data Layer. Callbacks run on the main thread. */
class PhoneLink(ctx: Context) {
    private val app = ctx.applicationContext

    /** Phones that are connected right now and run the phone app (advertise [Protocol.CAP_PHONE]). */
    fun phones(cb: (List<Node>?) -> Unit) {
        Wearable.getCapabilityClient(app)
            .getCapability(Protocol.CAP_PHONE, CapabilityClient.FILTER_REACHABLE)
            .addOnSuccessListener { cb(it.nodes.toList()) }
            .addOnFailureListener {
                Log.w(TAG, "phone lookup failed: ${it.message}")
                cb(null)
            }
    }

    /** MessageClient is best effort: success only means the message was queued for the node. */
    fun send(nodeId: String, path: String, payload: ByteArray, cb: (Boolean) -> Unit) {
        Wearable.getMessageClient(app)
            .sendMessage(nodeId, path, payload)
            .addOnSuccessListener { cb(true) }
            .addOnFailureListener { cb(false) }
    }
}
