package com.voice2text.app.transcription

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechEnhancementProcessorTest {
    @Test
    fun processPreservesOriginalSamplesAndReturnsValidatedAudio() {
        val original = floatArrayOf(0.1f, -0.2f, 0.3f)
        val backend = FakeBackend { samples, sampleRate ->
            samples[0] = 0.9f
            EnhancedSpeech(floatArrayOf(0.05f, -0.1f, 0.2f), sampleRate)
        }
        val processor = SpeechEnhancementProcessor(backend)

        val result = processor.process(original, 16_000)

        assertArrayEquals(floatArrayOf(0.1f, -0.2f, 0.3f), original, 0.0f)
        assertArrayEquals(floatArrayOf(0.05f, -0.1f, 0.2f), result.samples, 0.0f)
        assertEquals(16_000, result.sampleRate)
        assertEquals(1, backend.calls)
    }

    @Test
    fun cancellationBeforeOrAfterInferenceDiscardsTheCandidate() {
        val backend = FakeBackend { samples, sampleRate ->
            EnhancedSpeech(samples, sampleRate)
        }
        val before = SpeechEnhancementProcessor(backend)
        assertThrows(TranscriptionCanceledException::class.java) {
            before.process(floatArrayOf(0.1f), 16_000) { true }
        }
        assertEquals(0, backend.calls)

        var checks = 0
        val after = SpeechEnhancementProcessor(backend)
        assertThrows(TranscriptionCanceledException::class.java) {
            after.process(floatArrayOf(0.1f), 16_000) {
                checks += 1
                checks > 1
            }
        }
        assertEquals(1, backend.calls)
    }

    @Test
    fun invalidRateEmptyAndNonFiniteOutputsFailClosed() {
        val invalidRate = SpeechEnhancementProcessor(
            FakeBackend { samples, _ -> EnhancedSpeech(samples, 48_000) },
        )
        val empty = SpeechEnhancementProcessor(
            FakeBackend { _, sampleRate -> EnhancedSpeech(floatArrayOf(), sampleRate) },
        )
        val nonFinite = SpeechEnhancementProcessor(
            FakeBackend { _, sampleRate ->
                EnhancedSpeech(floatArrayOf(Float.NaN), sampleRate)
            },
        )

        assertThrows(IllegalArgumentException::class.java) {
            invalidRate.process(floatArrayOf(0.1f), 16_000)
        }
        assertThrows(IllegalStateException::class.java) {
            empty.process(floatArrayOf(0.1f), 16_000)
        }
        assertThrows(IllegalStateException::class.java) {
            nonFinite.process(floatArrayOf(0.1f), 16_000)
        }
    }

    @Test
    fun closeReleasesExactlyOnceAndPreventsFutureInference() {
        val backend = FakeBackend { samples, sampleRate ->
            EnhancedSpeech(samples, sampleRate)
        }
        val processor = SpeechEnhancementProcessor(backend)

        processor.close()
        processor.close()

        assertEquals(1, backend.releases)
        assertThrows(IllegalStateException::class.java) {
            processor.process(floatArrayOf(0.1f), 16_000)
        }
        assertTrue(backend.calls == 0)
    }

    private class FakeBackend(
        private val transform: (FloatArray, Int) -> EnhancedSpeech,
    ) : SpeechEnhancementBackend {
        var calls = 0
        var releases = 0

        override fun enhance(
            samples: FloatArray,
            sampleRate: Int,
        ): EnhancedSpeech {
            calls += 1
            return transform(samples, sampleRate)
        }

        override fun release() {
            releases += 1
        }
    }
}
