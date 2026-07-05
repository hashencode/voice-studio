package com.voice2text.app.recording

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import com.voice2text.app.contracts.AudioContract
import java.io.File
import java.util.UUID

class StandardRecordingSession(
    private val context: Context,
) {
    private var recorder: MediaRecorder? = null
    private var outputPath: String? = null
    private var isRecording = false
    private var isPaused = false
    private var startedAtMs: Long? = null
    private var accumulatedMs: Long = 0

    fun start() {
        if (isRecording || recorder != null) {
            throw RecordingSessionException("INVALID_STATE", "录音已在进行中")
        }

        try {
            val file = createOutputFile()
            outputPath = file.absolutePath

            val mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }

            mediaRecorder.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(AudioContract.SAMPLE_RATE_HZ)
                setAudioEncodingBitRate(AudioContract.BIT_RATE)
                setOutputFile(file.absolutePath)
                prepare()
                start()
            }

            recorder = mediaRecorder
            isRecording = true
            isPaused = false
            startedAtMs = System.currentTimeMillis()
            accumulatedMs = 0
        } catch (e: Exception) {
            cleanupRecorder()
            throw RecordingSessionException("START_FAILED", e.message ?: "启动录音失败")
        }
    }

    fun pause() {
        if (!isRecording || isPaused || recorder == null) {
            throw RecordingSessionException("INVALID_STATE", "当前不在可暂停的录音状态")
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            throw RecordingSessionException("UNSUPPORTED", "当前系统版本不支持暂停录音")
        }

        try {
            recorder?.pause()
            val now = System.currentTimeMillis()
            accumulatedMs += now - (startedAtMs ?: now)
            startedAtMs = null
            isPaused = true
        } catch (e: Exception) {
            throw RecordingSessionException("PAUSE_FAILED", e.message ?: "暂停录音失败")
        }
    }

    fun resume() {
        if (!isRecording || !isPaused || recorder == null) {
            throw RecordingSessionException("INVALID_STATE", "当前不在可继续的录音状态")
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            throw RecordingSessionException("UNSUPPORTED", "当前系统版本不支持继续录音")
        }

        try {
            recorder?.resume()
            isPaused = false
            startedAtMs = System.currentTimeMillis()
        } catch (e: Exception) {
            throw RecordingSessionException("RESUME_FAILED", e.message ?: "继续录音失败")
        }
    }

    fun stop(): RecordingSessionResult {
        if (!isRecording || recorder == null) {
            throw RecordingSessionException("INVALID_STATE", "当前没有正在进行的录音")
        }

        try {
            val now = System.currentTimeMillis()
            if (!isPaused && startedAtMs != null) {
                accumulatedMs += now - (startedAtMs ?: now)
            }

            recorder?.stop()
            recorder?.release()

            val path = outputPath ?: ""
            val result = RecordingSessionResult(
                path = path,
                durationMs = accumulatedMs.toInt(),
            )

            resetStateAfterStop()
            return result
        } catch (e: Exception) {
            cleanupRecorder()
            throw RecordingSessionException("STOP_FAILED", e.message ?: "停止录音失败")
        }
    }

    private fun createOutputFile(): File {
        val root = File(context.filesDir, AudioContract.RECORDING_DIR_NAME)
        if (!root.exists()) {
            root.mkdirs()
        }
        val name = "record-${System.currentTimeMillis()}-${UUID.randomUUID()}.${AudioContract.RECORDING_EXTENSION}"
        return File(root, name)
    }

    private fun resetStateAfterStop() {
        recorder = null
        outputPath = null
        isRecording = false
        isPaused = false
        startedAtMs = null
        accumulatedMs = 0
    }

    private fun cleanupRecorder() {
        try {
            recorder?.release()
        } catch (_: Exception) {
        }
        recorder = null
        outputPath = null
        isRecording = false
        isPaused = false
        startedAtMs = null
        accumulatedMs = 0
    }
}
