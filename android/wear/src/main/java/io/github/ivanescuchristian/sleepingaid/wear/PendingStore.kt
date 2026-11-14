// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.wear

import java.io.File

/**
 * Batches that have not been handed to the Data Layer yet: kept in memory and mirrored to a small file so a
 * process restart does not lose them. Bounded: the oldest batch is dropped first when [cap] is exceeded, which
 * limits both the file size and how much stale data could ever be sent after a long disconnection.
 */
class PendingStore(private val file: File, private val cap: Int = 600) {
    private val items = LinkedHashMap<Long, String>()

    val size: Int get() = items.size

    fun add(seq: Long, json: String) {
        items[seq] = json
        while (items.size > cap) items.remove(items.keys.first())
        persist()
    }

    fun remove(seq: Long) {
        if (items.remove(seq) != null) persist()
    }

    fun snapshot(): List<Pair<Long, String>> = items.map { it.key to it.value }

    fun clear() {
        items.clear()
        file.delete()
    }

    private fun persist() {
        try {
            if (items.isEmpty()) {
                file.delete()
                return
            }
            val tmp = File(file.path + ".tmp")
            tmp.bufferedWriter().use { w -> items.forEach { (seq, json) -> w.write("$seq\t$json\n") } }
            if (!tmp.renameTo(file)) {
                file.delete()
                tmp.renameTo(file)
            }
        } catch (_: Exception) {
            // Storage trouble only costs the restart safety net; the in-memory copy still works.
        }
    }
}
