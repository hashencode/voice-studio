package com.voice2text.app.transcription

import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiser
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserConfig
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserGtcrnModelConfig
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserModelConfig
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

internal data class EnhancedSpeech(
    val samples: FloatArray,
    val sampleRate: Int,
)

internal interface SpeechEnhancementBackend {
    fun enhance(
        samples: FloatArray,
        sampleRate: Int,
    ): EnhancedSpeech

    fun release()
}

internal class SpeechEnhancementProcessor(
    private val backend: SpeechEnhancementBackend,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)

    fun process(
        samples: FloatArray,
        sampleRate: Int,
        cancellationRequested: () -> Boolean = { false },
    ): EnhancedSpeech {
        check(!closed.get()) { "语音增强处理器已释放" }
        require(samples.isNotEmpty()) { "语音增强输入为空" }
        require(sampleRate == SUPPORTED_SAMPLE_RATE) {
            "GTCRN 语音增强仅支持 16000 Hz"
        }
        if (cancellationRequested()) {
            throw TranscriptionCanceledException()
        }

        val candidate = backend.enhance(samples.copyOf(), sampleRate)
        if (cancellationRequested()) {
            throw TranscriptionCanceledException()
        }
        check(candidate.samples.isNotEmpty()) { "语音增强模型返回空音频" }
        require(candidate.sampleRate == sampleRate) {
            "语音增强模型改变了采样率"
        }
        check(candidate.samples.all(Float::isFinite)) {
            "语音增强模型返回非有限采样"
        }
        return EnhancedSpeech(
            samples = candidate.samples.copyOf(),
            sampleRate = candidate.sampleRate,
        )
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) {
            backend.release()
        }
    }

    companion object {
        private const val SUPPORTED_SAMPLE_RATE = 16_000

        fun create(
            modelFile: File,
            numThreads: Int = 1,
        ): SpeechEnhancementProcessor {
            check(modelFile.isFile && modelFile.length() > 0L) {
                "GTCRN 语音增强模型文件不可用"
            }
            require(numThreads > 0) { "语音增强线程数必须大于 0" }
            val denoiser = OfflineSpeechDenoiser(
                null as android.content.res.AssetManager?,
                OfflineSpeechDenoiserConfig(
                    model = OfflineSpeechDenoiserModelConfig(
                        gtcrn = OfflineSpeechDenoiserGtcrnModelConfig(
                            model = modelFile.absolutePath,
                        ),
                        numThreads = numThreads,
                        debug = false,
                        provider = "cpu",
                    ),
                ),
            )
            return SpeechEnhancementProcessor(
                object : SpeechEnhancementBackend {
                    override fun enhance(
                        samples: FloatArray,
                        sampleRate: Int,
                    ): EnhancedSpeech {
                        val output = denoiser.run(samples, sampleRate)
                        return EnhancedSpeech(
                            samples = output.samples,
                            sampleRate = output.sampleRate,
                        )
                    }

                    override fun release() {
                        denoiser.release()
                    }
                },
            )
        }
    }
}
