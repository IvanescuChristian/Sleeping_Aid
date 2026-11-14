// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
package io.github.ivanescuchristian.sleepingaid.engine

/**
 * Just enough JSON for the parity fixtures (objects, arrays, numbers, strings, null). org.json is only a stub in
 * plain JVM unit tests, and a test-only dependency is not worth it for this. Numbers become Double via
 * toDouble(), which round-trips JavaScript's shortest-form output exactly.
 */
class MiniJson private constructor(private val s: String) {
    private var i = 0

    companion object {
        fun parse(text: String): Any? = MiniJson(text).run {
            val v = value()
            ws()
            check(i == s.length) { "trailing data at $i" }
            v
        }
    }

    private fun ws() {
        while (i < s.length && s[i].isWhitespace()) i++
    }

    private fun value(): Any? {
        ws()
        return when (val c = s[i]) {
            '{' -> obj()
            '[' -> arr()
            '"' -> str()
            'n' -> { i += 4; null }
            't' -> { i += 4; true }
            'f' -> { i += 5; false }
            else -> { check(c == '-' || c.isDigit()) { "bad char '$c' at $i" }; num() }
        }
    }

    private fun obj(): Map<String, Any?> {
        val m = LinkedHashMap<String, Any?>()
        i++
        ws()
        if (s[i] == '}') { i++; return m }
        while (true) {
            ws()
            val k = str()
            ws(); check(s[i++] == ':')
            m[k] = value()
            ws()
            val c = s[i++]
            if (c == '}') return m
            check(c == ',')
        }
    }

    private fun arr(): List<Any?> {
        val l = ArrayList<Any?>()
        i++
        ws()
        if (s[i] == ']') { i++; return l }
        while (true) {
            l.add(value())
            ws()
            val c = s[i++]
            if (c == ']') return l
            check(c == ',')
        }
    }

    private fun str(): String {
        check(s[i++] == '"')
        val b = StringBuilder()
        while (s[i] != '"') {
            if (s[i] == '\\') { i++; b.append(if (s[i] == 'n') '\n' else s[i]) } else b.append(s[i])
            i++
        }
        i++
        return b.toString()
    }

    private fun num(): Double {
        val st = i
        while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
        return s.substring(st, i).toDouble()
    }
}
