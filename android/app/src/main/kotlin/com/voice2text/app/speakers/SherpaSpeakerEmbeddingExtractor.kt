package com.voice2text.app.speakers

import android.content.Context
import android.content.res.AssetManager
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig

internal class SherpaSpeakerEmbeddingExtractor(
    private val context: Context,
    private val registry: SpeakerDiarizationModelRegistry =
        SpeakerDiarizationModelRegistry(context),
) : AutoCloseable {
    private var nativeExtractor: SpeakerEmbeddingExtractor? = null
    private var closed = false

    val dimension: Int
        get() = extractor().dim()

    fun extract(
        samples: FloatArray,
        sampleRate: Int = EXPECTED_SAMPLE_RATE,
    ): FloatArray? {
        check(!closed) { "说话人 embedding extractor 已关闭" }
        require(samples.isNotEmpty()) { "说话人 embedding 音频不能为空" }
        require(sampleRate == EXPECTED_SAMPLE_RATE) {
            "说话人 embedding 只接受 16 kHz 单声道 PCM"
        }
        val engine = extractor()
        val stream = engine.createStream()
        return try {
            stream.acceptWaveform(samples, sampleRate)
            stream.inputFinished()
            if (!engine.isReady(stream)) {
                null
            } else {
                engine.compute(stream).also { embedding ->
                    require(embedding.size == engine.dim()) {
                        "说话人 embedding 维度与 extractor 不一致"
                    }
                    require(embedding.all(Float::isFinite)) {
                        "说话人 embedding 包含非有限值"
                    }
                }
            }
        } finally {
            stream.release()
        }
    }

    override fun close() {
        if (closed) return
        nativeExtractor?.release()
        nativeExtractor = null
        closed = true
    }

    private fun extractor(): SpeakerEmbeddingExtractor {
        check(!closed) { "说话人 embedding extractor 已关闭" }
        nativeExtractor?.let { return it }
        val decision = registry.evaluateCandidateArtifacts()
        if (!decision.isAvailable) {
            throw SpeakerDiarizationUnavailableException(decision)
        }
        val config = SpeakerEmbeddingExtractorConfig(
            model = registry.embedding.assetPath,
            numThreads = 2,
            debug = false,
            provider = "cpu",
        )
        val created = when (registry.embedding.storage) {
            SpeakerModelStorage.FLUTTER_ASSET ->
                SpeakerEmbeddingExtractor(context.assets, config)
            SpeakerModelStorage.FILE_SYSTEM ->
                SpeakerEmbeddingExtractor(null as AssetManager?, config)
        }
        nativeExtractor = created
        return created
    }

    private companion object {
        const val EXPECTED_SAMPLE_RATE = 16_000
    }
}
