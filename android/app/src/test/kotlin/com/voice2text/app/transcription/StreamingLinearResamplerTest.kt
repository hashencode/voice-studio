package com.voice2text.app.transcription

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class StreamingLinearResamplerTest {
    @Test
    fun chunkBoundariesMatchOneShotResampling() {
        val input = ShortArray(44_100) { index -> ((index % 200) - 100).toShort() }
        val oneShot = StreamingLinearResampler(44_100, 16_000).process(input)
        val chunkedResampler = StreamingLinearResampler(44_100, 16_000)
        val chunked =
            buildList {
                input.asList().chunked(997).forEach { chunk ->
                    addAll(chunkedResampler.process(chunk.toShortArray()).asList())
                }
            }.toShortArray()

        assertArrayEquals(oneShot, chunked)
        assertEquals(16_000, chunked.size)
    }

    @Test
    fun passthroughRatePreservesSamplesAcrossChunks() {
        val resampler = StreamingLinearResampler(16_000, 16_000)
        val first = shortArrayOf(1, 2, 3)
        val second = shortArrayOf(4, 5)

        assertArrayEquals(first, resampler.process(first))
        assertArrayEquals(second, resampler.process(second))
    }
}
