package com.voice2text.app.privacy

import android.util.Log

object PrivacySafeLog {
    private val safeToken = Regex("[A-Za-z0-9_.-]{1,80}")
    private val safeEvent = Regex("[a-z0-9_]{1,80}")
    private val allowedFields =
        setOf(
            "category",
            "count",
            "jobId",
            "model",
            "durationMs",
            "costMs",
            "stage",
        )

    fun info(
        tag: String,
        event: String,
        fields: Map<String, Any?> = emptyMap(),
    ) {
        Log.i(tag, format(event, fields))
    }

    fun error(
        tag: String,
        event: String,
        fields: Map<String, Any?> = emptyMap(),
    ) {
        Log.e(tag, format(event, fields))
    }

    fun format(
        event: String,
        fields: Map<String, Any?> = emptyMap(),
    ): String {
        val safeName = event.takeIf(safeEvent::matches) ?: "invalid_event"
        val encoded =
            fields.entries
                .asSequence()
                .filter { it.key in allowedFields && it.value != null }
                .sortedBy { it.key }
                .joinToString(" ") { (key, value) ->
                    "$key=${safeValue(value ?: "redacted")}"
                }
        return if (encoded.isEmpty()) "event=$safeName" else "event=$safeName $encoded"
    }

    private fun safeValue(value: Any): String =
        when (value) {
            is Number, is Boolean -> value.toString()
            else -> value.toString().takeIf(safeToken::matches) ?: "redacted"
        }
}
