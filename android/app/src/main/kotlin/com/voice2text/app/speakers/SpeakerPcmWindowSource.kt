package com.voice2text.app.speakers

import com.voice2text.app.transcription.TranscriptionCanceledException
import com.voice2text.app.transcription.WavPcmChunkReader
import com.voice2text.app.transcription.WavPcmFormat
import java.io.File

internal data class SpeakerPcmWindow(
    val startSample: Long,
    val samples: FloatArray,
    val isFinal: Boolean,
) {
    init {
        require(startSample >= 0) { "说话人窗口起点不能为负数" }
        require(samples.isNotEmpty()) { "说话人窗口不能为空" }
    }

    val endSampleExclusive: Long
        get() = startSample + samples.size
}

internal class SpeakerPcmWindowSource(
    file: File,
    val windowSamples: Int,
    val overlapSamples: Int,
    val readChunkSamples: Int = minOf(DEFAULT_READ_CHUNK_SAMPLES, windowSamples),
) {
    private val reader = WavPcmChunkReader(file)

    init {
        require(windowSamples > 0) { "说话人窗口大小必须为正数" }
        require(overlapSamples >= 0) { "说话人窗口 overlap 不能为负数" }
        require(overlapSamples < windowSamples) {
            "说话人窗口 overlap 必须小于窗口大小"
        }
        require(readChunkSamples > 0) { "PCM 读取块大小必须为正数" }
        require(readChunkSamples <= windowSamples) {
            "PCM 读取块不能大于说话人窗口"
        }
    }

    val format: WavPcmFormat
        get() = reader.format

    val plannedWindowCount: Long
        get() {
            val totalSamples = format.totalSamples
            if (totalSamples <= windowSamples) return 1
            val samplesAfterFirstWindow = totalSamples - windowSamples
            return 1 + ceilDiv(samplesAfterFirstWindow, stepSamples.toLong())
        }

    val maximumResidentPcmSamples: Int
        get() = (2 * windowSamples) + readChunkSamples

    fun readWindows(
        cancellationRequested: () -> Boolean = { false },
        consume: (SpeakerPcmWindow) -> Unit,
    ) {
        var windowStart = 0L
        var buffer = FloatArray(windowSamples)
        var bufferedSamples = 0
        var consumedSamples = 0L
        var finalWindowEmitted = false

        reader.readChunks(
            maxSamplesPerChunk = readChunkSamples,
            cancellationRequested = cancellationRequested,
        ) { chunkStart, samples ->
            check(chunkStart == consumedSamples) { "PCM chunk 不连续" }
            var sourceOffset = 0
            while (sourceOffset < samples.size) {
                throwIfCanceled(cancellationRequested)
                val copiedSamples = minOf(
                    windowSamples - bufferedSamples,
                    samples.size - sourceOffset,
                )
                samples.copyInto(
                    destination = buffer,
                    destinationOffset = bufferedSamples,
                    startIndex = sourceOffset,
                    endIndex = sourceOffset + copiedSamples,
                )
                sourceOffset += copiedSamples
                bufferedSamples += copiedSamples
                consumedSamples += copiedSamples

                if (bufferedSamples == windowSamples) {
                    val isFinal =
                        windowStart + windowSamples == format.totalSamples
                    throwIfCanceled(cancellationRequested)
                    consume(
                        SpeakerPcmWindow(
                            startSample = windowStart,
                            samples = buffer,
                            isFinal = isFinal,
                        ),
                    )
                    if (isFinal) {
                        finalWindowEmitted = true
                        buffer = FloatArray(0)
                        bufferedSamples = 0
                    } else {
                        val nextBuffer = FloatArray(windowSamples)
                        if (overlapSamples > 0) {
                            buffer.copyInto(
                                destination = nextBuffer,
                                startIndex = windowSamples - overlapSamples,
                                endIndex = windowSamples,
                            )
                        }
                        buffer = nextBuffer
                        bufferedSamples = overlapSamples
                        windowStart += stepSamples
                    }
                }
            }
        }

        check(consumedSamples == format.totalSamples) { "PCM 输入未完整消费" }
        val hasUnemittedSamples =
            !finalWindowEmitted &&
                if (windowStart == 0L) {
                    bufferedSamples > 0
                } else {
                    bufferedSamples > overlapSamples
                }
        if (hasUnemittedSamples) {
            throwIfCanceled(cancellationRequested)
            consume(
                SpeakerPcmWindow(
                    startSample = windowStart,
                    samples = buffer.copyOf(bufferedSamples),
                    isFinal = true,
                ),
            )
        }
    }

    private val stepSamples: Int
        get() = windowSamples - overlapSamples

    private fun ceilDiv(
        value: Long,
        divisor: Long,
    ): Long = (value + divisor - 1) / divisor

    private fun throwIfCanceled(cancellationRequested: () -> Boolean) {
        if (cancellationRequested()) throw TranscriptionCanceledException()
    }

    private companion object {
        const val DEFAULT_READ_CHUNK_SAMPLES = 16_000
    }
}
