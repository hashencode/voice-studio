package com.voice2text.app.recording

data class RecordingSessionResult(
    val path: String,
    val durationMs: Int,
)

class RecordingSessionException(
    val code: String,
    override val message: String,
) : Exception(message)
