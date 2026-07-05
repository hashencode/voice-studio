package com.voice2text.app.recording

import android.content.Context
import com.voice2text.app.contracts.AudioContract
import com.voice2text.app.realtime.AudioRecordCapture
import com.voice2text.app.realtime.PcmAudioNormalizer
import com.voice2text.app.realtime.PcmFrame
import com.voice2text.app.realtime.RealtimeAsrProcessor
import com.voice2text.app.realtime.RealtimeAudioFileWriter
import com.voice2text.app.realtime.RealtimeRecordingFileRecovery
import com.voice2text.app.realtime.RealtimeTranscriptionEvent
import java.io.File
import java.util.UUID

class RealtimeRecordingSession(
    private val context: Context,
    private val emitEvent: (RealtimeTranscriptionEvent) -> Unit,
) {
    private var capture: AudioRecordCapture? = null
    private var writer: RealtimeAudioFileWriter? = null
    private var processor: RealtimeAsrProcessor? = null
    private var outputPath: String? = null
    private var tempPath: String? = null
    private var sessionId: String? = null

    @Volatile
    private var isRecording = false
    @Volatile
    private var isPaused = false
    private var startedAtMs: Long? = null
    private var accumulatedMs: Long = 0
    private var timelineMs = 0
    private var frameIndex = 0L

    fun start() {
        if (isRecording || capture != null) {
            throw RecordingSessionException("INVALID_STATE", "实时录音已在进行中")
        }

        try {
            val root = recordingsDir()
            RealtimeRecordingFileRecovery(root).cleanupStaleTempFiles()
            val id = UUID.randomUUID().toString()
            val finalFile = File(
                root,
                "record-${System.currentTimeMillis()}-$id.${AudioContract.REALTIME_RECORDING_EXTENSION}",
            )
            val tempFile = File(root, "${finalFile.name}.tmp")
            outputPath = finalFile.absolutePath
            tempPath = tempFile.absolutePath
            sessionId = id

            val audioWriter = RealtimeAudioFileWriter(
                tempFile = tempFile,
                finalFile = finalFile,
                sampleRateHz = AudioContract.SAMPLE_RATE_HZ,
                channelCount = AudioContract.CHANNEL_COUNT,
            )
            audioWriter.open()
            writer = audioWriter

            processor = RealtimeAsrProcessor(
                context = context,
                recordingPath = finalFile.absolutePath,
                sessionId = id,
                emitEvent = emitEvent,
            )

            capture = AudioRecordCapture(
                sampleRateHz = AudioContract.SAMPLE_RATE_HZ,
                onFrame = ::handleFrame,
                onError = { error ->
                    emitEvent(
                        RealtimeTranscriptionEvent.degradation(
                            recordingPath = outputPath ?: "",
                            reason = error.message ?: "实时采集异常",
                            sessionId = sessionId,
                        ),
                    )
                },
            )
            capture?.start()

            isRecording = true
            isPaused = false
            startedAtMs = System.currentTimeMillis()
            accumulatedMs = 0
            timelineMs = 0
            frameIndex = 0
        } catch (e: Exception) {
            cleanup()
            throw RecordingSessionException("START_FAILED", e.message ?: "启动实时录音失败")
        }
    }

    fun pause() {
        if (!isRecording || isPaused || capture == null) {
            throw RecordingSessionException("INVALID_STATE", "当前不在可暂停的实时录音状态")
        }
        capture?.pause()
        val now = System.currentTimeMillis()
        accumulatedMs += now - (startedAtMs ?: now)
        startedAtMs = null
        isPaused = true
    }

    fun resume() {
        if (!isRecording || !isPaused || capture == null) {
            throw RecordingSessionException("INVALID_STATE", "当前不在可继续的实时录音状态")
        }
        capture?.resume()
        startedAtMs = System.currentTimeMillis()
        isPaused = false
    }

    fun stop(): RecordingSessionResult {
        if (!isRecording || capture == null || writer == null) {
            throw RecordingSessionException("INVALID_STATE", "当前没有正在进行的实时录音")
        }

        try {
            val now = System.currentTimeMillis()
            if (!isPaused && startedAtMs != null) {
                accumulatedMs += now - (startedAtMs ?: now)
            }
            capture?.stop()
            capture = null
            processor?.finishAndWait()
            processor = null
            val finalFile = writer?.finish()
                ?: throw IllegalStateException("实时录音文件未创建")
            writer = null
            val duration = maxOf(accumulatedMs.toInt(), timelineMs)
            if (duration <= 0 || finalFile.length() <= 44L) {
                finalFile.delete()
                throw IllegalStateException("实时录音文件无有效音频")
            }
            resetStateAfterStop()
            return RecordingSessionResult(
                path = finalFile.absolutePath,
                durationMs = duration,
            )
        } catch (e: Exception) {
            cleanup()
            throw RecordingSessionException("STOP_FAILED", e.message ?: "停止实时录音失败")
        }
    }

    @Synchronized
    private fun handleFrame(data: ByteArray) {
        val durationMs = PcmAudioNormalizer.durationMsForPcm16(
            byteCount = data.size,
            sampleRateHz = AudioContract.SAMPLE_RATE_HZ,
            channelCount = AudioContract.CHANNEL_COUNT,
        )
        val frame = PcmFrame(
            data = data,
            sampleRateHz = AudioContract.SAMPLE_RATE_HZ,
            channelCount = AudioContract.CHANNEL_COUNT,
            sequenceIndex = frameIndex++,
            startMs = timelineMs,
            durationMs = durationMs,
        )
        timelineMs += durationMs
        writer?.writePcm(data)
        processor?.acceptFrame(frame)
    }

    private fun recordingsDir(): File {
        val root = File(context.filesDir, AudioContract.RECORDING_DIR_NAME)
        if (!root.exists()) {
            root.mkdirs()
        }
        return root
    }

    private fun resetStateAfterStop() {
        capture = null
        writer = null
        processor = null
        outputPath = null
        tempPath = null
        sessionId = null
        isRecording = false
        isPaused = false
        startedAtMs = null
        accumulatedMs = 0
        timelineMs = 0
        frameIndex = 0
    }

    private fun cleanup() {
        try {
            capture?.stop()
        } catch (_: Exception) {
        }
        try {
            writer?.abort()
        } catch (_: Exception) {
        }
        capture = null
        writer = null
        processor = null
        tempPath?.let { File(it).delete() }
        isRecording = false
        isPaused = false
        startedAtMs = null
        accumulatedMs = 0
        timelineMs = 0
        frameIndex = 0
    }
}
