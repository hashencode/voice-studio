package com.voice2text.app.transcription

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VadTimestampMapperTest {
    @Test
    fun sampleOffsetsMapToStableNonOverlappingMilliseconds() {
        val mapper = VadTimestampMapper(sampleRate = 16_000)

        val first = mapper.map(0, "第一段", startSample = 1600, sampleCount = 8000)
        val second = mapper.map(1, "第二段", startSample = 20_000, sampleCount = 16_000)

        assertEquals(100L, first.startMs)
        assertEquals(600L, first.endMs)
        assertEquals(1250L, second.startMs)
        assertEquals(2250L, second.endMs)
        assertNull(second.confidence)
    }

    @Test
    fun roundingCannotCreateOverlappingBounds() {
        val mapper = VadTimestampMapper(sampleRate = 44_100)

        val first = mapper.map(0, "一", startSample = 0, sampleCount = 45)
        val second = mapper.map(1, "二", startSample = 44, sampleCount = 45)

        assertEquals(first.endMs, second.startMs)
        assertEquals(true, second.endMs > second.startMs)
    }
}
