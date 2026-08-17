package com.voice2text.app.speakers

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeakerDiarizationCandidateContractTest {
    @Test
    fun candidateReceivesOnlyOneBoundedWindow() {
        val candidate = RecordingCandidate(maximumWindowSamples = 8)
        val window = SpeakerPcmWindow(
            startSample = 24,
            samples = FloatArray(8),
            isFinal = false,
        )

        val result = candidate.processWindow(window)

        assertEquals(8, candidate.observedSampleCount)
        assertEquals("test-candidate", result.candidateId)
        assertEquals(24L, result.windowStartSample)
        assertEquals(32L, result.windowEndSampleExclusive)
        assertEquals(1, result.turns.size)
        assertTrue(result.elapsedNanos >= 0)
    }

    @Test
    fun candidateRejectsInputAboveItsDeclaredBound() {
        val candidate = RecordingCandidate(maximumWindowSamples = 8)
        val window = SpeakerPcmWindow(
            startSample = 0,
            samples = FloatArray(9),
            isFinal = true,
        )

        assertThrows(IllegalArgumentException::class.java) {
            candidate.processWindow(window)
        }

        assertEquals(0, candidate.observedSampleCount)
    }

    @Test
    fun candidateRejectsOutOfBoundsLocalTurns() {
        val candidate = RecordingCandidate(
            maximumWindowSamples = 8,
            turns = listOf(
                DiarizationTurn(
                    startSeconds = 0.0,
                    endSeconds = 1.0,
                    speakerIndex = 0,
                ),
            ),
        )
        val window = SpeakerPcmWindow(
            startSample = 0,
            samples = FloatArray(8),
            isFinal = true,
        )

        assertThrows(IllegalArgumentException::class.java) {
            candidate.processWindow(window)
        }
    }

    @Test
    fun candidateBoundaryHasNoTranscriptOrPersistenceSurface() {
        val exposedNames = (
            SpeakerPcmWindow::class.java.declaredFields.asSequence() +
                SpeakerDiarizationCandidateResult::class.java.declaredFields.asSequence()
            )
            .map { it.name.lowercase() }
            .toList()

        assertFalse(exposedNames.any { "transcript" in it })
        assertFalse(exposedNames.any { "embedding" in it })
        assertFalse(exposedNames.any { "database" in it || "voiceprint" in it })
    }

    private class RecordingCandidate(
        maximumWindowSamples: Int,
        private val turns: List<DiarizationTurn> = listOf(
            DiarizationTurn(
                startSeconds = 0.0,
                endSeconds = 0.00025,
                speakerIndex = 0,
            ),
        ),
    ) : SpeakerDiarizationCandidate(
        candidateId = "test-candidate",
        maximumWindowSamples = maximumWindowSamples,
    ) {
        var observedSampleCount = 0

        override fun diarizeBoundedWindow(
            samples: FloatArray,
            sampleRate: Int,
            numberOfSpeakers: Int,
        ): List<DiarizationTurn> {
            observedSampleCount = samples.size
            return turns
        }

        override fun close() = Unit
    }
}
