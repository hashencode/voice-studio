package com.voice2text.app.recording

data class RecordingSessionResult(
    val sessionId: String,
    val path: String,
    val durationMs: Int,
    val state: String,
    val stopReason: String?,
)

class RecordingSessionException(
    val code: String,
    override val message: String,
) : Exception(message)
