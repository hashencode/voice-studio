package com.voice2text.app.realtime

data class PcmFrame(
    val data: ByteArray,
    val sampleRateHz: Int,
    val channelCount: Int,
    val sequenceIndex: Long,
    val startMs: Int,
    val durationMs: Int,
) {
    val endMs: Int get() = startMs + durationMs
}
