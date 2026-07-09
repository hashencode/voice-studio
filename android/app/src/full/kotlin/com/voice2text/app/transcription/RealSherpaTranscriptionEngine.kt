package com.voice2text.app.transcription

import android.content.Context
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineParaformerModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineStream
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import com.k2fsa.sherpa.onnx.WaveReader
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.math.min

internal class RealSherpaTranscriptionEngine(
    private val context: Context,
    private val transcoder: TranscodePort = NativeAudioTranscoder(),
    private val modelAssetManager: ModelAssetManager = ModelAssetManager(context),
    private val readinessChecker: ModelReadinessChecker = ModelReadinessChecker(modelAssetManager),
) : TranscriptionEngine {
    override fun transcribe(request: TranscriptionRequest): String {
        if (request.recordingPath.isBlank()) {
            throw IllegalArgumentException("recordingPath 不能为空")
        }

        val recordingFile = File(request.recordingPath)
        if (!recordingFile.exists()) {
            throw IllegalArgumentException("录音文件不存在: ${request.recordingPath}")
        }
        val wasInputWav = recordingFile.extension.equals("wav", ignoreCase = true)
        val transcodeDir = File(context.cacheDir, "transcoded_audio")
        cleanupTranscodeDir(transcodeDir)
        val wavFile = try {
            transcoder.ensureWav16kMono(
                input = recordingFile,
                outputDir = transcodeDir,
            )
        } catch (e: TranscodeException) {
            throw IllegalStateException("转码失败: ${e.message}", e)
        } catch (e: Exception) {
            throw IllegalStateException("转码失败: ${e.message ?: "未知错误"}", e)
        }

        val readiness = readinessChecker.check(request.modelId)
        if (!readiness.offlineReady || !readiness.vadReady) {
            throw IllegalStateException(readiness.reason ?: "模型暂不可用于离线识别")
        }
        val extractedModel = modelAssetManager.ensureParaformerExtracted(request.modelId)
        if (!extractedModel.modelFile.exists() || !extractedModel.tokensFile.exists()) {
            throw IllegalStateException("模型解压失败: onnx/tokens 文件不存在")
        }
        val vadModelFile = modelAssetManager.ensureVadExtracted()

        val recognizer = OfflineRecognizer(
            null as android.content.res.AssetManager?,
            createRecognizerConfig(
                modelFilePath = extractedModel.modelFile.absolutePath,
                tokensFilePath = extractedModel.tokensFile.absolutePath,
                sampleRateHz = request.sampleRateHz,
                numThreads = RECOGNIZER_THREADS,
            ),
        )

        try {
            val wave = WaveReader.Companion.readWave(wavFile.absolutePath)
            val text = transcribeVadSegments(
                recognizer = recognizer,
                samples = wave.samples,
                sampleRate = wave.sampleRate,
                vadModelFile = vadModelFile,
            )
            if (text.isEmpty()) {
                throw IllegalStateException("识别失败: Sherpa 返回空文本，请检查音频有效性与模型配置")
            }
            return text
        } catch (e: IllegalStateException) {
            throw e
        } catch (e: Exception) {
            throw IllegalStateException("识别失败: ${e.message ?: "未知错误"}", e)
        } finally {
            try {
                recognizer.release()
            } catch (_: Exception) {
            }
            if (!wasInputWav && wavFile.exists()) {
                try {
                    wavFile.delete()
                } catch (_: Exception) {
                }
            }
        }
    }

    private fun createRecognizerConfig(
        modelFilePath: String,
        tokensFilePath: String,
        sampleRateHz: Int,
        numThreads: Int,
    ): OfflineRecognizerConfig {
        val featureConfig = FeatureConfig(
            sampleRate = sampleRateHz,
            featureDim = 80,
            dither = 0.0f,
        )
        val modelConfig = OfflineModelConfig(
            paraformer = OfflineParaformerModelConfig(model = modelFilePath),
            numThreads = numThreads,
            provider = "cpu",
            debug = false,
            modelType = "paraformer",
            tokens = tokensFilePath,
        )
        return OfflineRecognizerConfig(
            featConfig = featureConfig,
            modelConfig = modelConfig,
        )
    }

    private fun transcribeVadSegments(
        recognizer: OfflineRecognizer,
        samples: FloatArray,
        sampleRate: Int,
        vadModelFile: File,
    ): String {
        val vad = Vad(
            null as android.content.res.AssetManager?,
            VadModelConfig(
                sileroVadModelConfig = SileroVadModelConfig(
                    model = vadModelFile.absolutePath,
                    threshold = VAD_THRESHOLD,
                    minSilenceDuration = VAD_MIN_SILENCE_SEC,
                    minSpeechDuration = VAD_MIN_SPEECH_SEC,
                    windowSize = VAD_WINDOW_SIZE,
                    maxSpeechDuration = VAD_MAX_SPEECH_SEC,
                ),
                sampleRate = VAD_SAMPLE_RATE_HZ,
                numThreads = VAD_THREADS,
                provider = "cpu",
                debug = false,
            ),
        )
        val texts = mutableListOf<String>()
        var detectedSegments = 0

        try {
            fun drainDetectedSegments() {
                while (!vad.empty()) {
                    val speech = vad.front()
                    detectedSegments += 1
                    val text = decodeSamples(
                        recognizer = recognizer,
                        samples = speech.samples,
                        sampleRate = sampleRate,
                    )
                    if (text.isNotBlank()) {
                        texts.add(text)
                    }
                    vad.pop()
                }
            }

            val chunkSize = (sampleRate / 10).coerceAtLeast(VAD_WINDOW_SIZE)
            var start = 0
            while (start < samples.size) {
                val end = min(start + chunkSize, samples.size)
                vad.acceptWaveform(samples.copyOfRange(start, end))
                drainDetectedSegments()
                start = end
            }
            vad.flush()
            drainDetectedSegments()
        } finally {
            try {
                vad.release()
            } catch (_: Exception) {
            }
        }

        if (detectedSegments == 0) {
            throw IllegalStateException("识别失败: VAD 未检测到语音片段")
        }
        return texts.joinToString(" ").trim()
    }

    private fun decodeSamples(
        recognizer: OfflineRecognizer,
        samples: FloatArray,
        sampleRate: Int,
    ): String {
        var stream: OfflineStream? = null
        return try {
            stream = recognizer.createStream()
            stream.acceptWaveform(samples, sampleRate)
            recognizer.decode(stream)
            recognizer.getResult(stream).text.trim()
        } finally {
            try {
                stream?.release()
            } catch (_: Exception) {
            }
        }
    }

    private fun cleanupTranscodeDir(dir: File) {
        if (!dir.exists() || !dir.isDirectory) return
        val files = dir.listFiles()?.filter { it.isFile && it.extension.equals("wav", ignoreCase = true) } ?: return
        if (files.isEmpty()) return

        val now = System.currentTimeMillis()
        val expireMs = TimeUnit.HOURS.toMillis(24)
        files.forEach { f ->
            if (now - f.lastModified() > expireMs) {
                try {
                    f.delete()
                } catch (_: Exception) {
                }
            }
        }

        val remained = dir.listFiles()?.filter { it.isFile && it.extension.equals("wav", ignoreCase = true) } ?: return
        if (remained.size <= 20) return
        remained.sortedBy { it.lastModified() }
            .take(remained.size - 20)
            .forEach { old ->
                try {
                    old.delete()
                } catch (_: Exception) {
                }
            }
    }

    private companion object {
        const val RECOGNIZER_THREADS = 4
        const val VAD_SAMPLE_RATE_HZ = 16000
        const val VAD_WINDOW_SIZE = 512
        const val VAD_THREADS = 1
        const val VAD_THRESHOLD = 0.15f
        const val VAD_MIN_SILENCE_SEC = 0.20f
        const val VAD_MIN_SPEECH_SEC = 0.25f
        const val VAD_MAX_SPEECH_SEC = 5.0f
    }
}
