package com.voice2text.app.transcription

data class ModelCapabilityGate(
    val available: Boolean,
    val verified: Boolean,
    val reason: String,
) {
    init {
        require(!verified || available) {
            "A verified capability must also be available"
        }
        require(verified || reason.isNotBlank()) {
            "An unverified capability must explain why it is unavailable"
        }
    }
}

data class TranscriptionModelDescriptor(
    val id: String,
    val assetPath: String,
    val offlineReady: Boolean,
    val vadRequired: Boolean,
    val punctuationReady: Boolean,
    val itn: ModelCapabilityGate,
    val confidence: ModelCapabilityGate,
    val hotwords: ModelCapabilityGate,
    val enhancement: ModelCapabilityGate,
) {
    val denoiseReady: Boolean
        get() = enhancement.verified
}

object TranscriptionModelRegistry {
    private const val FLUTTER_ASSET_PREFIX = "flutter_assets/"
    const val DEFAULT_MODEL_ID = "paraformer-zh"

    private val itnUnavailable =
        ModelCapabilityGate(
            available = false,
            verified = false,
            reason = "itn_asset_missing",
        )
    private val confidenceUnavailable =
        ModelCapabilityGate(
            available = false,
            verified = false,
            reason = "recognizer_confidence_unavailable",
        )
    private val paraformerHotwordsUnavailable =
        ModelCapabilityGate(
            available = false,
            verified = false,
            reason = "paraformer_hotwords_unsupported",
        )
    private val enhancementCandidate =
        ModelCapabilityGate(
            available = true,
            verified = false,
            reason = "enhancement_benchmark_pending",
        )

    val models = listOf(
        TranscriptionModelDescriptor(
            id = DEFAULT_MODEL_ID,
            assetPath = "${FLUTTER_ASSET_PREFIX}assets/sherpa/asr/paraformer-zh.zip",
            offlineReady = true,
            vadRequired = true,
            punctuationReady = true,
            itn = itnUnavailable,
            confidence = confidenceUnavailable,
            hotwords = paraformerHotwordsUnavailable,
            enhancement = enhancementCandidate,
        ),
    )

    fun descriptorFor(modelId: String): TranscriptionModelDescriptor {
        return models.firstOrNull { it.id == modelId }
            ?: models.first { it.id == DEFAULT_MODEL_ID }
    }
}
