package com.voice2text.app.recording

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingStorageGuardTest {
    @Test
    fun allowsRecordingAtOrAboveReserve() {
        val guard =
            RecordingStorageGuard(
                availableBytesProvider = { 512L },
                minimumReserveBytes = 512L,
            )

        assertTrue(guard.canStart())
        assertTrue(guard.hasSafeReserve())
        guard.requireCanStart()
    }

    @Test
    fun rejectsRecordingBelowReserveWithStableCategory() {
        val guard =
            RecordingStorageGuard(
                availableBytesProvider = { 511L },
                minimumReserveBytes = 512L,
            )

        assertFalse(guard.canStart())
        val error = runCatching { guard.requireCanStart() }.exceptionOrNull()
        assertTrue(error is RecordingSessionException)
        assertEquals("LOW_STORAGE", (error as RecordingSessionException).code)
    }

    @Test
    fun negativeAvailableSpaceIsClampedToZero() {
        val guard =
            RecordingStorageGuard(
                availableBytesProvider = { -1L },
                minimumReserveBytes = 1L,
            )

        assertEquals(0L, guard.availableBytes())
        assertFalse(guard.hasSafeReserve())
    }
}
