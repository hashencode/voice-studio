package com.voice2text.app.realtime

import android.content.Context
import com.voice2text.app.contracts.AudioContract
import com.voice2text.app.transcription.ModelAssetManager
import com.voice2text.app.transcription.ModelReadinessChecker
import com.voice2text.app.transcription.TranscriptionEngineRouter
import com.voice2text.app.transcription.TranscriptionModelRegistry
import com.voice2text.app.transcription.TranscriptionRequest
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class RealtimeAsrProcessor(
    private val context: Context,
    private val recordingPath: String,
    private val sessionId: String,
    private val emitEvent: (RealtimeTranscriptionEvent) -> Unit,
    private val modelId: String = TranscriptionModelRegistry.DEFAULT_MODEL_ID,
    private val vadSegmenter: VadSegmenter = VadSegmenter(),
    private val degradationPolicy: RealtimeDegradationPolicy = RealtimeDegradationPolicy(),
    private val engineRouter: TranscriptionEngineRouter = TranscriptionEngineRouter(context),
) {
    private val executor = Executors.newSingleThreadExecutor()
    private val queuedSegments = AtomicInteger(0)
    private val segmentBuffer = ByteArrayOutputStream()
    private var nextSequenceId = 0
    private var currentSegmentStartMs = 0
    private var lastFrameEndMs = 0
    private var enabled = true

    init {
        val readiness = ModelReadinessChecker(ModelAssetManager(context)).check(modelId)
        if (!readiness.realtimeReady) {
            enabled = false
            emitEvent(
                RealtimeTranscriptionEvent.degradation(
                    recordingPath = recordingPath,
                    reason = readiness.reason ?: "实时模型未就绪",
                    sessionId = sessionId,
                ),
            )
        }
    }

    @Synchronized
    fun acceptFrame(frame: PcmFrame) {
        if (!enabled) return
        lastFrameEndMs = frame.endMs
        val wasInSpeech = vadSegmenter.isInSpeech
        val decision = vadSegmenter.accept(frame)

        if (decision.started) {
            segmentBuffer.reset()
            currentSegmentStartMs = decision.startMs
        }

        val shouldAppend = decision.started || vadSegmenter.isInSpeech || wasInSpeech
        if (shouldAppend) {
            segmentBuffer.write(frame.data)
        }

        if (decision.ended) {
            submitBufferedSegment(decision.startMs, decision.endMs)
            segmentBuffer.reset()
        } else if (wasInSpeech && !vadSegmenter.isInSpeech) {
            segmentBuffer.reset()
        }
    }

    @Synchronized
    fun finishAndWait() {
        if (enabled) {
            val decision = vadSegmenter.forceEnd(lastFrameEndMs)
            if (decision != null && segmentBuffer.size() > 0) {
                submitBufferedSegment(currentSegmentStartMs, decision.endMs)
                segmentBuffer.reset()
            }
        }
        executor.shutdown()
        try {
            if (!executor.awaitTermination(12, TimeUnit.SECONDS)) {
                emitEvent(
                    RealtimeTranscriptionEvent.degradation(
                        recordingPath = recordingPath,
                        reason = "实时识别收尾超时，录音已保存",
                        sessionId = sessionId,
                    ),
                )
                executor.shutdownNow()
            }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun submitBufferedSegment(startMs: Int, endMs: Int) {
        val pcm = segmentBuffer.toByteArray()
        if (pcm.isEmpty()) return
        val queued = queuedSegments.get()
        if (degradationPolicy.shouldDropSegment(queued)) {
            emitEvent(
                RealtimeTranscriptionEvent.degradation(
                    recordingPath = recordingPath,
                    reason = "实时识别队列过长，当前语音段已跳过",
                    sessionId = sessionId,
                ),
            )
            return
        }

        val sequenceId = nextSequenceId++
        queuedSegments.incrementAndGet()
        executor.execute {
            val segmentFile = File(
                context.cacheDir,
                "realtime_segments/${UUID.randomUUID()}.${AudioContract.REALTIME_RECORDING_EXTENSION}",
            )
            try {
                RealtimeAudioFileWriter.writeWavFile(
                    file = segmentFile,
                    pcmData = pcm,
                    sampleRateHz = AudioContract.SAMPLE_RATE_HZ,
                    channelCount = AudioContract.CHANNEL_COUNT,
                )
                val text = engineRouter.resolve("real").transcribe(
                    TranscriptionRequest(
                        recordingPath = segmentFile.absolutePath,
                        durationMs = (endMs - startMs).coerceAtLeast(0),
                        modelId = modelId,
                        sampleRateHz = AudioContract.SAMPLE_RATE_HZ,
                        enablePunctuation = false,
                        enableDenoise = false,
                        engineMode = "real",
                    ),
                ).trim()
                if (text.isNotEmpty()) {
                    emitEvent(
                        RealtimeTranscriptionEvent.segment(
                            recordingPath = recordingPath,
                            sequenceId = sequenceId,
                            text = text,
                            startMs = startMs,
                            endMs = endMs,
                            sessionId = sessionId,
                        ),
                    )
                }
            } catch (e: Exception) {
                emitEvent(
                    RealtimeTranscriptionEvent.degradation(
                        recordingPath = recordingPath,
                        reason = e.message ?: "实时语音段识别失败",
                        sessionId = sessionId,
                    ),
                )
            } finally {
                queuedSegments.decrementAndGet()
                segmentFile.delete()
            }
        }
    }
}
