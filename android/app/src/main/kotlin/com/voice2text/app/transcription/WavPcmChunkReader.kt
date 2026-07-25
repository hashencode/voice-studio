package com.voice2text.app.transcription

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

internal data class WavPcmFormat(
    val sampleRate: Int,
    val channelCount: Int,
    val bitsPerSample: Int,
    val totalSamples: Long,
)

internal class WavPcmChunkReader(
    private val file: File,
) {
    private data class Header(
        val format: WavPcmFormat,
        val dataOffset: Long,
        val dataSize: Long,
    )

    private val header = parseHeader(file)

    val format: WavPcmFormat
        get() = header.format

    fun readChunks(
        maxSamplesPerChunk: Int = DEFAULT_MAX_SAMPLES,
        cancellationRequested: () -> Boolean = { false },
        consume: (startSample: Long, samples: FloatArray) -> Unit,
    ) {
        require(maxSamplesPerChunk > 0)
        RandomAccessFile(file, "r").use { input ->
            input.seek(header.dataOffset)
            val bytes = ByteArray(maxSamplesPerChunk * PCM16_BYTES)
            var remaining = header.dataSize
            var startSample = 0L
            while (remaining > 0) {
                if (cancellationRequested()) throw TranscriptionCanceledException()
                val requested = minOf(bytes.size.toLong(), remaining).toInt()
                val read = input.read(bytes, 0, requested)
                if (read <= 0) break
                val sampleCount = read / PCM16_BYTES
                val samples = FloatArray(sampleCount)
                val buffer = ByteBuffer.wrap(bytes, 0, sampleCount * PCM16_BYTES)
                    .order(ByteOrder.LITTLE_ENDIAN)
                for (index in 0 until sampleCount) {
                    samples[index] = buffer.short / 32768.0f
                }
                consume(startSample, samples)
                startSample += sampleCount
                remaining -= read
            }
        }
    }

    private fun parseHeader(file: File): Header {
        RandomAccessFile(file, "r").use { input ->
            require(readAscii(input, 4) == "RIFF") { "WAV 缺少 RIFF 标记" }
            readUInt32(input)
            require(readAscii(input, 4) == "WAVE") { "WAV 缺少 WAVE 标记" }
            var sampleRate: Int? = null
            var channelCount: Int? = null
            var bitsPerSample: Int? = null
            var dataOffset: Long? = null
            var dataSize: Long? = null
            while (input.filePointer + 8 <= input.length()) {
                val chunkId = readAscii(input, 4)
                val chunkSize = readUInt32(input)
                val chunkStart = input.filePointer
                when (chunkId) {
                    "fmt " -> {
                        require(chunkSize >= 16) { "WAV fmt 块无效" }
                        val audioFormat = readUInt16(input)
                        channelCount = readUInt16(input)
                        sampleRate = readUInt32(input).toInt()
                        input.skipBytes(6)
                        bitsPerSample = readUInt16(input)
                        require(audioFormat == PCM_FORMAT) { "仅支持 PCM WAV" }
                    }
                    "data" -> {
                        dataOffset = input.filePointer
                        dataSize = minOf(chunkSize, input.length() - input.filePointer)
                    }
                }
                val alignedSize = chunkSize + (chunkSize and 1L)
                input.seek(minOf(chunkStart + alignedSize, input.length()))
                if (sampleRate != null && dataOffset != null) break
            }
            require(sampleRate == EXPECTED_SAMPLE_RATE) { "WAV 采样率必须为 16000 Hz" }
            require(channelCount == 1) { "WAV 必须为单声道" }
            require(bitsPerSample == 16) { "WAV 必须为 16-bit PCM" }
            val size = requireNotNull(dataSize) { "WAV 缺少 data 块" }
            require(size >= PCM16_BYTES) { "WAV data 块为空" }
            return Header(
                format = WavPcmFormat(
                    sampleRate = sampleRate,
                    channelCount = channelCount,
                    bitsPerSample = bitsPerSample,
                    totalSamples = size / PCM16_BYTES,
                ),
                dataOffset = requireNotNull(dataOffset),
                dataSize = size,
            )
        }
    }

    private fun readAscii(
        input: RandomAccessFile,
        length: Int,
    ): String {
        val bytes = ByteArray(length)
        input.readFully(bytes)
        return bytes.toString(Charsets.US_ASCII)
    }

    private fun readUInt16(input: RandomAccessFile): Int {
        val low = input.readUnsignedByte()
        val high = input.readUnsignedByte()
        return low or (high shl 8)
    }

    private fun readUInt32(input: RandomAccessFile): Long {
        var value = 0L
        repeat(4) { index ->
            value = value or (input.readUnsignedByte().toLong() shl (index * 8))
        }
        return value
    }

    private companion object {
        const val PCM_FORMAT = 1
        const val PCM16_BYTES = 2
        const val EXPECTED_SAMPLE_RATE = 16_000
        const val DEFAULT_MAX_SAMPLES = 16_000
    }
}
