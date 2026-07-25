package com.voice2text.app.transcription

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.floor
import kotlin.math.roundToInt

internal interface TranscodePort {
    fun ensureWav16kMono(
        input: File,
        outputDir: File,
        context: TranscriptionExecutionContext = TranscriptionExecutionContext.none(),
    ): File
}

internal class FfmpegAudioTranscoder : TranscodePort {
    override fun ensureWav16kMono(
        input: File,
        outputDir: File,
        context: TranscriptionExecutionContext,
    ): File {
        throw TranscodeException("FFmpeg 转码器尚未接入，请先使用 NativeAudioTranscoder")
    }
}

internal class NativeAudioTranscoder : TranscodePort {
    override fun ensureWav16kMono(
        input: File,
        outputDir: File,
        context: TranscriptionExecutionContext,
    ): File {
        context.report("transcode", 0.05)
        if (input.extension.equals("wav", ignoreCase = true)) {
            val normalized = runCatching { WavPcmChunkReader(input).format }.getOrNull()
            if (normalized?.sampleRate == TARGET_SAMPLE_RATE &&
                normalized.channelCount == 1 &&
                normalized.bitsPerSample == 16
            ) {
                context.report("transcode", 0.30)
                return input
            }
        }
        if (!outputDir.exists()) {
            outputDir.mkdirs()
        }
        val output = File(
            outputDir,
            "${input.nameWithoutExtension}-${System.currentTimeMillis()}-16k-mono.wav",
        )
        val stagedOutput = File(outputDir, "${output.name}.partial")
        transcodeMediaToWav16kMono(input, stagedOutput, context)
        if (!stagedOutput.renameTo(output)) {
            stagedOutput.delete()
            throw TranscodeException("无法提交转码后的 WAV 文件")
        }
        context.report("transcode", 0.30)
        return output
    }

    private fun transcodeMediaToWav16kMono(
        input: File,
        output: File,
        context: TranscriptionExecutionContext,
    ) {
        val extractor = MediaExtractor()
        var codec: MediaCodec? = null
        val rawPcm = File(output.parentFile, "${output.name}.pcm.partial")
        var rawOutput: FileOutputStream? = null
        var completed = false
        try {
            extractor.setDataSource(input.absolutePath)
            val trackIndex = selectAudioTrack(extractor)
            if (trackIndex < 0) {
                throw IllegalStateException("未找到音频轨道")
            }
            extractor.selectTrack(trackIndex)
            val trackFormat = extractor.getTrackFormat(trackIndex)
            val durationUs =
                if (trackFormat.containsKey(MediaFormat.KEY_DURATION)) {
                    trackFormat.getLong(MediaFormat.KEY_DURATION).coerceAtLeast(1L)
                } else {
                    1L
                }
            val mime = trackFormat.getString(MediaFormat.KEY_MIME)
                ?: throw IllegalStateException("音频 MIME 为空")
            codec = MediaCodec.createDecoderByType(mime)
            codec.configure(trackFormat, null, null, 0)
            codec.start()

            val bufferInfo = MediaCodec.BufferInfo()
            rawOutput = FileOutputStream(rawPcm)
            var sawInputEos = false
            var sawOutputEos = false
            var lastReportedPercent = -1

            while (!sawOutputEos) {
                context.throwIfCanceled()
                if (!sawInputEos) {
                    val inIndex = codec.dequeueInputBuffer(10_000)
                    if (inIndex >= 0) {
                        val inputBuffer = codec.getInputBuffer(inIndex)
                            ?: throw IllegalStateException("无法获取解码输入缓冲区")
                        inputBuffer.clear()
                        val sampleSize = extractor.readSampleData(inputBuffer, 0)
                        if (sampleSize < 0) {
                            codec.queueInputBuffer(
                                inIndex,
                                0,
                                0,
                                0,
                                MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                            )
                            sawInputEos = true
                        } else {
                            val progressPercent =
                                ((extractor.sampleTime.coerceAtLeast(0L) * 100L) / durationUs)
                                    .toInt()
                                    .coerceIn(0, 100)
                            if (progressPercent >= lastReportedPercent + 5) {
                                lastReportedPercent = progressPercent
                                context.report(
                                    "transcode",
                                    0.05 + (0.20 * progressPercent / 100.0),
                                )
                            }
                            codec.queueInputBuffer(
                                inIndex,
                                0,
                                sampleSize,
                                extractor.sampleTime,
                                0,
                            )
                            extractor.advance()
                        }
                    }
                }

                val outIndex = codec.dequeueOutputBuffer(bufferInfo, 10_000)
                when {
                    outIndex >= 0 -> {
                        val outBuffer = codec.getOutputBuffer(outIndex)
                        if (outBuffer != null && bufferInfo.size > 0) {
                            val chunk = ByteArray(bufferInfo.size)
                            outBuffer.position(bufferInfo.offset)
                            outBuffer.limit(bufferInfo.offset + bufferInfo.size)
                            outBuffer.get(chunk)
                            rawOutput.write(chunk)
                        }
                        codec.releaseOutputBuffer(outIndex, false)
                        if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                            sawOutputEos = true
                        }
                    }
                    outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        // Use final output format after decode for sample/channels.
                    }
                }
            }

            val outFormat = codec.outputFormat
            val srcSampleRate = outFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            val srcChannelCount = outFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            val pcmEncoding = if (outFormat.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
                outFormat.getInteger(MediaFormat.KEY_PCM_ENCODING)
            } else {
                2 // ENCODING_PCM_16BIT
            }
            rawOutput.flush()
            rawOutput.close()
            rawOutput = null
            context.throwIfCanceled()
            convertRawPcmToWav(
                rawPcm = rawPcm,
                output = output,
                srcSampleRate = srcSampleRate,
                srcChannelCount = srcChannelCount,
                pcmEncoding = pcmEncoding,
                context = context,
            )
            completed = true
        } finally {
            try {
                rawOutput?.close()
            } catch (_: Exception) {
            }
            try {
                codec?.stop()
            } catch (_: Exception) {
            }
            try {
                codec?.release()
            } catch (_: Exception) {
            }
            try {
                extractor.release()
            } catch (_: Exception) {
            }
            if (rawPcm.exists()) {
                try {
                    rawPcm.delete()
                } catch (_: Exception) {
                }
            }
            if (!completed && output.exists()) {
                try {
                    output.delete()
                } catch (_: Exception) {
                }
            }
        }
    }

    private fun selectAudioTrack(extractor: MediaExtractor): Int {
        for (i in 0 until extractor.trackCount) {
            val format = extractor.getTrackFormat(i)
            val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
            if (mime.startsWith("audio/")) return i
        }
        return -1
    }

    private fun convertRawPcmToWav(
        rawPcm: File,
        output: File,
        srcSampleRate: Int,
        srcChannelCount: Int,
        pcmEncoding: Int,
        context: TranscriptionExecutionContext,
    ) {
        if (srcSampleRate <= 0) throw TranscodeException("无效采样率: $srcSampleRate")
        if (srcChannelCount <= 0) throw TranscodeException("无效声道数: $srcChannelCount")
        val bytesPerSample = when (pcmEncoding) {
            2 -> 2
            3 -> 1
            else -> throw TranscodeException("暂不支持 PCM 编码: $pcmEncoding")
        }
        val frameBytes = bytesPerSample * srcChannelCount
        val resampler = StreamingLinearResampler(srcSampleRate, TARGET_SAMPLE_RATE)
        var writtenSamples = 0L
        RandomAccessFile(output, "rw").use { wav ->
            wav.setLength(0)
            wav.write(ByteArray(WAV_HEADER_BYTES))
            FileInputStream(rawPcm).use { input ->
                val buffer = ByteArray(RAW_CHUNK_BYTES)
                var remainder = ByteArray(0)
                while (true) {
                    context.throwIfCanceled()
                    val read = input.read(buffer)
                    if (read < 0) break
                    val combined = ByteArray(remainder.size + read)
                    remainder.copyInto(combined)
                    buffer.copyInto(combined, remainder.size, 0, read)
                    val usableBytes = combined.size - (combined.size % frameBytes)
                    if (usableBytes == 0) {
                        remainder = combined
                        continue
                    }
                    val decoded = decodePcmToInterleaved(
                        combined.copyOfRange(0, usableBytes),
                        srcChannelCount,
                        pcmEncoding,
                    )
                    val mono = downMixToMono(decoded, srcChannelCount)
                    val normalized = resampler.process(mono)
                    writePcm16(wav, normalized)
                    writtenSamples += normalized.size
                    remainder = combined.copyOfRange(usableBytes, combined.size)
                }
                if (remainder.isNotEmpty()) {
                    throw TranscodeException("PCM 数据未按完整采样帧结束")
                }
            }
            require(writtenSamples > 0) { "解码后的 PCM 为空" }
            val dataBytes = writtenSamples * 2L
            require(dataBytes <= Int.MAX_VALUE) { "WAV 文件超过 2GB 上限" }
            wav.seek(0)
            wav.write(wavHeader(dataBytes.toInt()))
        }
    }

    private fun decodePcmToInterleaved(
        bytes: ByteArray,
        channelCount: Int,
        pcmEncoding: Int,
    ): ShortArray {
        if (channelCount <= 0) throw TranscodeException("无效声道数: $channelCount")
        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        return when (pcmEncoding) {
            2 -> { // ENCODING_PCM_16BIT
                val out = ShortArray(bytes.size / 2)
                var i = 0
                while (bb.remaining() >= 2) {
                    out[i++] = bb.short
                }
                out
            }
            3 -> { // ENCODING_PCM_8BIT
                val out = ShortArray(bytes.size)
                for (i in bytes.indices) {
                    val u = bytes[i].toInt() and 0xFF
                    out[i] = ((u - 128) shl 8).toShort()
                }
                out
            }
            else -> throw TranscodeException("暂不支持 PCM 编码: $pcmEncoding")
        }
    }

    private fun downMixToMono(interleaved: ShortArray, channels: Int): ShortArray {
        if (channels == 1) return interleaved
        val frames = interleaved.size / channels
        val out = ShortArray(frames)
        var src = 0
        for (i in 0 until frames) {
            var sum = 0
            for (c in 0 until channels) {
                sum += interleaved[src++].toInt()
            }
            out[i] = (sum / channels).toShort()
        }
        return out
    }

    private fun writePcm16(
        output: RandomAccessFile,
        pcm: ShortArray,
    ) {
        if (pcm.isEmpty()) return
        val bytes = ByteBuffer.allocate(pcm.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        pcm.forEach(bytes::putShort)
        output.write(bytes.array())
    }

    private fun wavHeader(dataSize: Int): ByteArray =
        ByteBuffer.allocate(WAV_HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray())
            putInt(36 + dataSize)
            put("WAVE".toByteArray())
            put("fmt ".toByteArray())
            putInt(16)
            putShort(1) // PCM
            putShort(1) // mono
            putInt(TARGET_SAMPLE_RATE)
            putInt(TARGET_SAMPLE_RATE * 2)
            putShort(2)
            putShort(16)
            put("data".toByteArray())
            putInt(dataSize)
        }.array()

    private companion object {
        const val TARGET_SAMPLE_RATE = 16_000
        const val RAW_CHUNK_BYTES = 64 * 1024
        const val WAV_HEADER_BYTES = 44
    }
}

internal class StreamingLinearResampler(
    srcRate: Int,
    dstRate: Int,
) {
    private val sourceStep = srcRate.toDouble() / dstRate
    private var nextSourcePosition = 0.0
    private var processedSamples = 0L
    private var previousSample: Short? = null

    init {
        require(srcRate > 0)
        require(dstRate > 0)
    }

    fun process(input: ShortArray): ShortArray {
        if (input.isEmpty()) return input
        val start = processedSamples
        val last = start + input.lastIndex
        val estimated =
            ((input.size + 2) / sourceStep).roundToInt().coerceAtLeast(1)
        val output = ShortArray(estimated + 2)
        var size = 0
        while (nextSourcePosition <= last) {
            val leftIndex = floor(nextSourcePosition).toLong()
            val fraction = nextSourcePosition - leftIndex
            val left = sampleAt(leftIndex, start, input) ?: break
            val right = if (fraction == 0.0) {
                left
            } else {
                sampleAt(leftIndex + 1, start, input) ?: break
            }
            val sample = left * (1.0 - fraction) + right * fraction
            output[size++] = sample.roundToInt().toShort()
            nextSourcePosition += sourceStep
        }
        processedSamples += input.size
        previousSample = input.last()
        return output.copyOf(size)
    }

    private fun sampleAt(
        absoluteIndex: Long,
        chunkStart: Long,
        input: ShortArray,
    ): Short? {
        if (absoluteIndex == chunkStart - 1) return previousSample
        val local = absoluteIndex - chunkStart
        return if (local in 0..input.lastIndex.toLong()) {
            input[local.toInt()]
        } else {
            null
        }
    }
}

internal class TranscodeException(message: String, cause: Throwable? = null) : Exception(message, cause)
