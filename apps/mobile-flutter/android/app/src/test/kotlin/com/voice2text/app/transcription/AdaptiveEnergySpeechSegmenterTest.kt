package com.voice2text.app.transcription

import org.junit.Assert.assertEquals
import org.junit.Test

class AdaptiveEnergySpeechSegmenterTest {
    private val segmenter = AdaptiveEnergySpeechSegmenter()

    @Test
    fun `splits only at sustained low-energy gaps`() {
        val samples =
            concatenate(
                constant(500, 0.10f),
                constant(500, 0.001f),
                constant(700, 0.08f),
                constant(500, 0.001f),
                constant(600, 0.12f),
            )

        val ranges = segmenter.split(samples, SAMPLE_RATE)

        assertEquals(
            listOf(
                SpeechSampleRange(msToSamples(0), msToSamples(520)),
                SpeechSampleRange(msToSamples(1000), msToSamples(1720)),
                SpeechSampleRange(msToSamples(2200), msToSamples(2800)),
            ),
            ranges,
        )
    }

    @Test
    fun `keeps a brief low-energy gap inside one speech segment`() {
        val samples =
            concatenate(
                constant(600, 0.10f),
                constant(200, 0.001f),
                constant(600, 0.08f),
            )

        assertEquals(
            listOf(SpeechSampleRange(0, samples.size)),
            segmenter.split(samples, SAMPLE_RATE),
        )
    }

    @Test
    fun `adapts to a quiet recording instead of requiring a fixed amplitude`() {
        val samples =
            concatenate(
                constant(500, 0.004f),
                constant(500, 0.0001f),
                constant(500, 0.005f),
            )

        assertEquals(2, segmenter.split(samples, SAMPLE_RATE).size)
    }

    private fun constant(
        durationMs: Int,
        amplitude: Float,
    ): FloatArray = FloatArray(msToSamples(durationMs)) { amplitude }

    private fun concatenate(vararg values: FloatArray): FloatArray {
        val result = FloatArray(values.sumOf { it.size })
        var offset = 0
        values.forEach { value ->
            value.copyInto(result, destinationOffset = offset)
            offset += value.size
        }
        return result
    }

    private fun msToSamples(durationMs: Int): Int = SAMPLE_RATE * durationMs / 1000

    private companion object {
        const val SAMPLE_RATE = 16_000
    }
}
