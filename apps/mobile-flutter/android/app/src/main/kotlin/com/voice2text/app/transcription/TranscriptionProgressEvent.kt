package com.voice2text.app.transcription

data class TranscriptionProgressEvent(
    val jobId: Int,
    val stage: String,
    val progress: Double,
    val status: String,
    val errorCode: String? = null,
) {
    fun toMap(): Map<String, Any?> =
        mapOf(
            "jobId" to jobId,
            "stage" to stage,
            "progress" to progress,
            "status" to status,
            "errorCode" to errorCode,
        )
}
