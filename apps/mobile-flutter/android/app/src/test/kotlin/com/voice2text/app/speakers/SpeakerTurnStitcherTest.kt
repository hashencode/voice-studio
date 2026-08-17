package com.voice2text.app.speakers

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeakerTurnStitcherTest {
    @Test
    fun distinguishesAssignedUnknownAndSilence() {
        val result = SpeakerTurnStitcher().stitch(
            windows = listOf(
                window(
                    start = 0,
                    end = 10,
                    activity(2, 4, "speaker_1"),
                    activity(5, 7, null),
                ),
            ),
            totalSamples = 10,
            sampleRate = 16_000,
        )

        assertEquals(
            listOf(
                interval(0, 2, SpeakerSemanticKind.SILENCE),
                interval(2, 4, SpeakerSemanticKind.ASSIGNED, "speaker_1"),
                interval(4, 5, SpeakerSemanticKind.SILENCE),
                interval(5, 7, SpeakerSemanticKind.UNKNOWN),
                interval(7, 10, SpeakerSemanticKind.SILENCE),
            ),
            result.intervals,
        )
    }

    @Test
    fun simultaneousAssignedActivityProducesExplicitOverlap() {
        val result = SpeakerTurnStitcher().stitch(
            windows = listOf(
                window(
                    start = 0,
                    end = 10,
                    activity(2, 6, "speaker_1"),
                    activity(4, 8, "speaker_2"),
                ),
            ),
            totalSamples = 10,
            sampleRate = 16_000,
        )

        assertEquals(
            interval(
                4,
                6,
                SpeakerSemanticKind.OVERLAP,
                "speaker_1",
                "speaker_2",
            ),
            result.intervals.single { it.kind == SpeakerSemanticKind.OVERLAP },
        )
    }

    @Test
    fun overlappingWindowsAreOwnedDeterministicallyAndDeduplicated() {
        val result = SpeakerTurnStitcher().stitch(
            windows = listOf(
                window(
                    start = 0,
                    end = 10,
                    activity(4, 10, "speaker_1"),
                ),
                window(
                    start = 6,
                    end = 16,
                    activity(6, 12, "speaker_1"),
                ),
            ),
            totalSamples = 16,
            sampleRate = 16_000,
        )

        assertEquals(
            listOf(
                interval(0, 4, SpeakerSemanticKind.SILENCE),
                interval(4, 12, SpeakerSemanticKind.ASSIGNED, "speaker_1"),
                interval(12, 16, SpeakerSemanticKind.SILENCE),
            ),
            result.intervals,
        )
        assertTrue(
            result.intervals.zipWithNext().all { (left, right) ->
                left.endSampleExclusive == right.startSample
            },
        )
    }

    @Test
    fun activityOutsideItsWindowFailsClosed() {
        assertThrows(IllegalArgumentException::class.java) {
            SpeakerTurnStitcher().stitch(
                windows = listOf(
                    window(
                        start = 5,
                        end = 10,
                        activity(4, 6, "speaker_1"),
                    ),
                ),
                totalSamples = 10,
                sampleRate = 16_000,
            )
        }
    }

    private fun window(
        start: Long,
        end: Long,
        vararg activities: SpeakerWindowActivity,
    ) = SpeakerWindowSemanticEvidence(
        windowStartSample = start,
        windowEndSampleExclusive = end,
        activities = activities.toList(),
    )

    private fun activity(
        start: Long,
        end: Long,
        key: String?,
    ) = SpeakerWindowActivity(
        startSample = start,
        endSampleExclusive = end,
        audioSpeakerKey = key,
    )

    private fun interval(
        start: Long,
        end: Long,
        kind: SpeakerSemanticKind,
        vararg keys: String,
    ) = SpeakerSemanticInterval(
        startSample = start,
        endSampleExclusive = end,
        kind = kind,
        audioSpeakerKeys = keys.toSet(),
        unknownSpeakerCount = if (kind == SpeakerSemanticKind.UNKNOWN) 1 else 0,
    )
}
