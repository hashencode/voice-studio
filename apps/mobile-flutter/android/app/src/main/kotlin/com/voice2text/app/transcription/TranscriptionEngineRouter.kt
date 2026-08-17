package com.voice2text.app.transcription

import android.content.Context

class TranscriptionEngineRouter internal constructor(
    private val real: TranscriptionEngine,
) {
    constructor(context: Context) : this(RealSherpaTranscriptionEngine(context))

    fun resolve(): TranscriptionEngine = real
}
