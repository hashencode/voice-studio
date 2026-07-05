package com.voice2text.app.realtime

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

class AudioRecordCapture(
    private val sampleRateHz: Int,
    private val onFrame: (ByteArray) -> Unit,
    private val onError: (Exception) -> Unit,
) {
    private var audioRecord: AudioRecord? = null
    private var captureThread: Thread? = null
    private val running = AtomicBoolean(false)
    private val paused = AtomicBoolean(false)

    @SuppressLint("MissingPermission")
    fun start() {
        if (running.get()) {
            throw IllegalStateException("实时采集已在进行中")
        }

        val minBuffer = AudioRecord.getMinBufferSize(
            sampleRateHz,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuffer <= 0) {
            throw IllegalStateException("无法初始化 AudioRecord buffer")
        }
        val bufferSize = max(minBuffer * 2, sampleRateHz / 5 * 2)
        val record = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            sampleRateHz,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferSize,
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            throw IllegalStateException("AudioRecord 初始化失败")
        }

        audioRecord = record
        running.set(true)
        paused.set(false)
        record.startRecording()

        captureThread = Thread({
            val buffer = ByteArray(bufferSize)
            try {
                while (running.get()) {
                    val read = record.read(buffer, 0, buffer.size)
                    if (read > 0 && !paused.get()) {
                        onFrame(buffer.copyOf(read))
                    } else if (read < 0) {
                        throw IllegalStateException("AudioRecord 读取失败: $read")
                    }
                }
            } catch (e: Exception) {
                if (running.get()) {
                    onError(e)
                }
            }
        }, "voice2text-audio-record")
        captureThread?.start()
    }

    fun pause() {
        paused.set(true)
    }

    fun resume() {
        paused.set(false)
    }

    fun stop() {
        running.set(false)
        try {
            audioRecord?.stop()
        } catch (_: Exception) {
        }
        try {
            captureThread?.join(1500)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        try {
            audioRecord?.release()
        } catch (_: Exception) {
        }
        audioRecord = null
        captureThread = null
        paused.set(false)
    }
}
