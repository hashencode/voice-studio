package com.voice2text.app.transcription

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class TranscriptionResultTest {
    @Test
    fun structuredResultSerializesOrderedFinalSegments() {
        val result =
            TranscriptionResult.fromSegments(
                listOf(
                    TranscriptionSegmentResult(
                        sequenceId = 0,
                        text = "第一段",
                        startMs = 100,
                        endMs = 900,
                        confidence = 0.75,
                    ),
                    TranscriptionSegmentResult(
                        sequenceId = 1,
                        text = "第二段",
                        startMs = 1200,
                        endMs = 2000,
                    ),
                ),
            )

        val map = result.toMap()
        val segments = map["segments"] as List<*>

        assertEquals("第一段 第二段", map["mergedText"])
        assertEquals(2, segments.size)
        assertEquals(1200L, (segments[1] as Map<*, *>)["startMs"])
        assertNull((segments[1] as Map<*, *>)["confidence"])
    }

    @Test
    fun overlappingOrMismatchedResultsAreRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            TranscriptionResult(
                mergedText = "一 二",
                segments =
                    listOf(
                        TranscriptionSegmentResult(0, "一", 0, 1000),
                        TranscriptionSegmentResult(1, "二", 900, 1200),
                    ),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            TranscriptionResult(
                mergedText = "错误顺序",
                segments =
                    listOf(
                        TranscriptionSegmentResult(0, "真实文本", 0, 1000),
                    ),
            )
        }
    }
}
