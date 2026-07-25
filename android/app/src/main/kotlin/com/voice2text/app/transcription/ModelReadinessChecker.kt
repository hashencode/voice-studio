package com.voice2text.app.transcription

data class ModelReadiness(
    val modelId: String,
    val offlineReady: Boolean,
    val vadReady: Boolean,
    val punctuationReady: Boolean,
    val denoiseReady: Boolean,
    val reason: String? = null,
)

class ModelReadinessChecker(
    private val assetManager: ModelAssetManager,
) {
    fun check(modelId: String): ModelReadiness {
        val descriptor = assetManager.descriptorFor(modelId)
        val missing = assetManager.requiredAssetsFor(descriptor.id)
            .filterNot { assetManager.assetExists(it) }
        val hasAssets = missing.isEmpty()
        val vadReady = !descriptor.vadRequired || assetManager.assetExists(VAD_ASSET_PATH)
        val punctuationReady =
            descriptor.punctuationReady &&
                assetManager.assetExists(PUNCTUATION_ASSET_PATH)

        val reason = when {
            !descriptor.offlineReady -> "模型暂未开放"
            !hasAssets -> "模型资源缺失: ${missing.joinToString(",")}"
            descriptor.vadRequired && !vadReady -> "VAD 资源缺失"
            else -> null
        }

        return ModelReadiness(
            modelId = descriptor.id,
            offlineReady = descriptor.offlineReady && hasAssets,
            vadReady = vadReady,
            punctuationReady = punctuationReady,
            denoiseReady = descriptor.denoiseReady,
            reason = reason,
        )
    }

    companion object {
        private const val VAD_ASSET_PATH = ModelAssetManager.VAD_ASSET_PATH
        private const val PUNCTUATION_ASSET_PATH =
            ModelAssetManager.PUNCTUATION_ASSET_PATH
    }
}
