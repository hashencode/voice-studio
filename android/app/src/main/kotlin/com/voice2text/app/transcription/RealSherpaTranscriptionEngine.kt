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
import java.io.File
import java.util.concurrent.TimeUnit

internal class RealSherpaTranscriptionEngine(
    private val context: Context,
    private val transcoder: TranscodePort = NativeAudioTranscoder(),
    private val modelAssetManager: ModelAssetManager = ModelAssetManager(context),
    private val readinessChecker: ModelReadinessChecker = ModelReadinessChecker(modelAssetManager),
    private val itnProcessorFactory: (() -> TextNormalizationPostProcessor)? = null,
) : TranscriptionEngine {
    override fun transcribe(
        request: TranscriptionRequest,
        executionContext: TranscriptionExecutionContext,
    ): TranscriptionResult {
        executionContext.report("input", 0.02)
        if (request.recordingPath.isBlank()) {
            throw IllegalArgumentException("recordingPath 不能为空")
        }

        val recordingFile = File(request.recordingPath)
        if (!recordingFile.exists()) {
            throw IllegalArgumentException("录音文件不存在")
        }
        val wasInputWav = recordingFile.extension.equals("wav", ignoreCase = true)
        val transcodeDir = File(context.cacheDir, "transcoded_audio")
        cleanupTranscodeDir(transcodeDir)
        val wavFile = try {
            transcoder.ensureWav16kMono(
                input = recordingFile,
                outputDir = transcodeDir,
                context = executionContext,
            )
        } catch (e: TranscodeException) {
            throw IllegalStateException("转码失败: ${e.message}", e)
        } catch (e: Exception) {
            throw IllegalStateException("转码失败: ${e.message ?: "未知错误"}", e)
        }

        executionContext.report("model", 0.35)
        val readiness = readinessChecker.check(request.modelId)
        if (!readiness.offlineReady || !readiness.vadReady) {
            throw IllegalStateException(readiness.reason ?: "模型暂不可用于离线识别")
        }
        val extractedModel = modelAssetManager.ensureParaformerExtracted(request.modelId)
        if (!extractedModel.modelFile.exists() || !extractedModel.tokensFile.exists()) {
            throw IllegalStateException("模型解压失败: onnx/tokens 文件不存在")
        }
        val vadModelFile = modelAssetManager.ensureVadExtracted()
        executionContext.throwIfCanceled()
        executionContext.report("model", 0.50)

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
            val decodedSegments = transcribeVadSegments(
                recognizer = recognizer,
                wavFile = wavFile,
                vadModelFile = vadModelFile,
                executionContext = executionContext,
            )
            val segments = if (request.enablePunctuation) {
                executionContext.report("punctuation", 0.955)
                if (!readiness.punctuationReady) {
                    throw IllegalStateException("标点模型资源缺失或不可用")
                }
                val punctuationModel = modelAssetManager.ensurePunctuationExtracted()
                PunctuationPostProcessor.create(
                    modelFile = punctuationModel,
                    numThreads = PUNCTUATION_THREADS,
                ).use { processor ->
                    decodedSegments.mapIndexed { index, segment ->
                        executionContext.throwIfCanceled()
                        val progress =
                            0.955 +
                                (0.015 * (index + 1).toDouble() / decodedSegments.size)
                        val punctuated = processor.process(segment.text)
                        executionContext.report("punctuation", progress)
                        segment.copy(text = punctuated)
                    }
                }
            } else {
                decodedSegments
            }
            val normalizedSegments = applyVerifiedItn(
                modelId = request.modelId,
                segments = segments,
                executionContext = executionContext,
            )
            if (normalizedSegments.isEmpty()) {
                throw IllegalStateException("识别失败: Sherpa 返回空文本，请检查音频有效性与模型配置")
            }
            return TranscriptionResult.fromSegments(normalizedSegments)
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

    private fun applyVerifiedItn(
        modelId: String,
        segments: List<TranscriptionSegmentResult>,
        executionContext: TranscriptionExecutionContext,
    ): List<TranscriptionSegmentResult> {
        val gate = modelAssetManager.descriptorFor(modelId).itn
        if (!gate.verified) {
            return segments
        }

        executionContext.report("itn", 0.972)
        val processor = checkNotNull(itnProcessorFactory) {
            "ITN 能力已标记为验证通过，但生产处理器未配置"
        }.invoke()
        return processor.processSegments(segments)
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
        wavFile: File,
        vadModelFile: File,
        executionContext: TranscriptionExecutionContext,
    ): List<TranscriptionSegmentResult> {
        executionContext.report("vad", 0.55)
        val reader = WavPcmChunkReader(wavFile)
        val sampleRate = reader.format.sampleRate
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
        val results = mutableListOf<TranscriptionSegmentResult>()
        val timestampMapper = VadTimestampMapper(sampleRate)
        val energySegmenter = AdaptiveEnergySpeechSegmenter()
        var detectedSpeechCount = 0
        var processedSamples = 0L

        try {
            fun drainDetectedSegments() {
                while (!vad.empty()) {
                    executionContext.throwIfCanceled()
                    val speech = vad.front()
                    detectedSpeechCount += 1
                    energySegmenter.split(speech.samples, sampleRate).forEach { range ->
                        val segmentSamples =
                            speech.samples.copyOfRange(
                                range.startOffset,
                                range.endOffsetExclusive,
                            )
                        val text = decodeSamples(
                            recognizer = recognizer,
                            samples = segmentSamples,
                            sampleRate = sampleRate,
                        )
                        if (text.isNotBlank()) {
                            results.add(
                                timestampMapper.map(
                                    sequenceId = results.size,
                                    text = text,
                                    startSample = speech.start.toLong() + range.startOffset,
                                    sampleCount = range.sampleCount,
                                    confidence = null,
                                ),
                            )
                        }
                    }
                    vad.pop()
                }
            }

            reader.readChunks(
                maxSamplesPerChunk = VAD_CHUNK_SAMPLES,
                cancellationRequested = {
                    try {
                        executionContext.throwIfCanceled()
                        false
                    } catch (_: TranscriptionCanceledException) {
                        true
                    }
                },
            ) { startSample, samples ->
                vad.acceptWaveform(samples)
                processedSamples = startSample + samples.size
                drainDetectedSegments()
                val ratio =
                    processedSamples.toDouble() /
                        reader.format.totalSamples.coerceAtLeast(1L)
                executionContext.report(
                    if (results.isEmpty()) "vad" else "decode",
                    0.55 + (0.39 * ratio.coerceIn(0.0, 1.0)),
                )
            }
            vad.flush()
            drainDetectedSegments()
        } finally {
            try {
                vad.release()
            } catch (_: Exception) {
            }
        }

        if (detectedSpeechCount == 0) {
            throw IllegalStateException("识别失败: VAD 未检测到语音片段")
        }
        if (results.isEmpty()) {
            throw IllegalStateException("识别失败: Sherpa 返回空文本，请检查音频有效性与模型配置")
        }
        executionContext.report("decode", 0.95)
        return results
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
        dir.listFiles()
            ?.filter { it.isFile && it.name.endsWith(".partial") }
            ?.forEach { partial ->
                try {
                    partial.delete()
                } catch (_: Exception) {
                }
            }
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
        const val VAD_CHUNK_SAMPLES = 16_000
        const val VAD_THREADS = 1
        const val PUNCTUATION_THREADS = 1
        const val VAD_THRESHOLD = 0.15f
        const val VAD_MIN_SILENCE_SEC = 0.20f
        const val VAD_MIN_SPEECH_SEC = 0.25f
        const val VAD_MAX_SPEECH_SEC = 5.0f
    }
}
