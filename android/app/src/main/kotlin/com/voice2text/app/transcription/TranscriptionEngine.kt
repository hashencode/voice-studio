package com.voice2text.app.transcription

data class TranscriptionRequest(
    val recordingPath: String,
    val durationMs: Int,
    val modelId: String,
    val sampleRateHz: Int,
    val enablePunctuation: Boolean,
    val enableDenoise: Boolean,
    val attemptCount: Int = 1,
)

interface TranscriptionEngine {
    fun transcribe(
        request: TranscriptionRequest,
        executionContext: TranscriptionExecutionContext = TranscriptionExecutionContext.none(),
    ): TranscriptionResult
}

class TranscriptionCanceledException : Exception("transcription canceled")

class TranscriptionExecutionContext internal constructor(
    val jobId: Int,
    private val progressListener: (TranscriptionProgressEvent) -> Unit,
    private val cancellationRequested: () -> Boolean,
) {
    @Volatile
    var currentStage: String = "input"
        private set

    private var lastProgress = 0.0

    @Synchronized
    fun report(
        stage: String,
        progress: Double,
    ) {
        throwIfCanceled()
        val normalized = progress.coerceIn(0.0, 1.0)
        if (normalized < lastProgress) return
        currentStage = stage
        lastProgress = normalized
        progressListener(
            TranscriptionProgressEvent(
                jobId = jobId,
                stage = stage,
                progress = normalized,
                status = "processing",
            ),
        )
    }

    fun throwIfCanceled() {
        if (cancellationRequested()) {
            throw TranscriptionCanceledException()
        }
    }

    fun isCancellationRequested(): Boolean = cancellationRequested()

    companion object {
        fun none(): TranscriptionExecutionContext =
            TranscriptionExecutionContext(
                jobId = 0,
                progressListener = {},
                cancellationRequested = { false },
            )
    }
}
