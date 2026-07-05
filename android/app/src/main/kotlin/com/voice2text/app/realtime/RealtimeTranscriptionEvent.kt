package com.voice2text.app.realtime

import com.voice2text.app.contracts.AudioContract

data class RealtimeTranscriptionEvent(
    val type: String,
    val recordingPath: String,
    val sequenceId: Int = -1,
    val text: String = "",
    val startMs: Int = 0,
    val endMs: Int = 0,
    val isFinal: Boolean = true,
    val source: String = "realtime",
    val sessionId: String? = null,
    val jobId: Int? = null,
    val confidence: Double? = null,
    val reason: String? = null,
) {
    fun toPayload(): Map<String, Any?> {
        return hashMapOf(
            "type" to type,
            "recordingPath" to recordingPath,
            "sequenceId" to sequenceId,
            "text" to text,
            "startMs" to startMs,
            "endMs" to endMs,
            "isFinal" to isFinal,
            "source" to source,
            "sessionId" to sessionId,
            "jobId" to jobId,
            "confidence" to confidence,
            "reason" to reason,
        )
    }

    companion object {
        fun segment(
            recordingPath: String,
            sequenceId: Int,
            text: String,
            startMs: Int,
            endMs: Int,
            sessionId: String? = null,
            confidence: Double? = null,
        ): RealtimeTranscriptionEvent {
            return RealtimeTranscriptionEvent(
                type = AudioContract.EVENT_TYPE_SEGMENT,
                recordingPath = recordingPath,
                sequenceId = sequenceId,
                text = text,
                startMs = startMs,
                endMs = endMs,
                isFinal = true,
                sessionId = sessionId,
                confidence = confidence,
            )
        }

        fun degradation(
            recordingPath: String,
            reason: String,
            sessionId: String? = null,
        ): RealtimeTranscriptionEvent {
            return RealtimeTranscriptionEvent(
                type = AudioContract.EVENT_TYPE_DEGRADATION,
                recordingPath = recordingPath,
                reason = reason,
                sessionId = sessionId,
            )
        }
    }
}
