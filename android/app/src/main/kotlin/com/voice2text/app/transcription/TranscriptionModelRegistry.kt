package com.voice2text.app.transcription

data class TranscriptionModelDescriptor(
    val id: String,
    val assetPath: String,
    val offlineReady: Boolean,
    val vadRequired: Boolean,
    val punctuationReady: Boolean,
    val denoiseReady: Boolean,
)

object TranscriptionModelRegistry {
    private const val FLUTTER_ASSET_PREFIX = "flutter_assets/"
    const val DEFAULT_MODEL_ID = "paraformer-zh"

    val models = listOf(
        TranscriptionModelDescriptor(
            id = DEFAULT_MODEL_ID,
            assetPath = "${FLUTTER_ASSET_PREFIX}assets/sherpa/asr/paraformer-zh.zip",
            offlineReady = true,
            vadRequired = true,
            punctuationReady = false,
            denoiseReady = false,
        ),
        TranscriptionModelDescriptor(
            id = "sherpa-streaming-zh",
            assetPath = "",
            offlineReady = false,
            vadRequired = true,
            punctuationReady = false,
            denoiseReady = false,
        ),
        TranscriptionModelDescriptor(
            id = "sherpa-offline-zh",
            assetPath = "",
            offlineReady = false,
            vadRequired = false,
            punctuationReady = false,
            denoiseReady = false,
        ),
    )

    fun descriptorFor(modelId: String): TranscriptionModelDescriptor {
        return models.firstOrNull { it.id == modelId }
            ?: models.first { it.id == DEFAULT_MODEL_ID }
    }
}
