package com.voice2text.app.transcription

import android.content.Context

internal class RealSherpaTranscriptionEngine(
    @Suppress("UNUSED_PARAMETER") context: Context,
    private val stub: TranscriptionEngine = StubSherpaTranscriptionEngine(),
) : TranscriptionEngine {
    override fun transcribe(request: TranscriptionRequest): String {
        return stub.transcribe(
            request.copy(engineMode = "ui-stub"),
        )
    }
}
