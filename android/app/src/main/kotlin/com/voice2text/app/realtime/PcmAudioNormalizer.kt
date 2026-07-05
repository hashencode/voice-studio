package com.voice2text.app.realtime

import kotlin.math.sqrt

object PcmAudioNormalizer {
    fun durationMsForPcm16(
        byteCount: Int,
        sampleRateHz: Int,
        channelCount: Int,
    ): Int {
        if (byteCount <= 0 || sampleRateHz <= 0 || channelCount <= 0) return 0
        val bytesPerSample = 2 * channelCount
        val sampleCount = byteCount / bytesPerSample
        return ((sampleCount * 1000L) / sampleRateHz).toInt().coerceAtLeast(1)
    }

    fun rmsPcm16(data: ByteArray, length: Int = data.size): Double {
        if (length < 2) return 0.0
        var sum = 0.0
        var count = 0
        var index = 0
        while (index + 1 < length) {
            val low = data[index].toInt() and 0xFF
            val high = data[index + 1].toInt()
            val sample = (high shl 8) or low
            sum += sample * sample.toDouble()
            count += 1
            index += 2
        }
        if (count == 0) return 0.0
        return sqrt(sum / count)
    }
}
