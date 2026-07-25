package com.voice2text.app.recording

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingInputSelectionStateTest {
    @Test
    fun selectingAutomaticInputClearsPreferredRouteAndFallback() {
        val state = RecordingInputSelectionState()
        state.select(42)
        state.markFallback(RecordingInputFallbackReasons.DEVICE_DISCONNECTED)

        state.select(null)

        assertNull(state.preferredDeviceId)
        assertNull(state.fallbackReason)
    }

    @Test
    fun removingUnrelatedDeviceKeepsPreferredRoute() {
        val state = RecordingInputSelectionState()
        state.select(42)

        val changed = state.handleRemovedDevices(setOf(7, 9))

        assertFalse(changed)
        assertEquals(42, state.preferredDeviceId)
        assertNull(state.fallbackReason)
    }

    @Test
    fun removingPreferredDeviceFallsBackToAutomaticRoute() {
        val state = RecordingInputSelectionState()
        state.select(42)

        val changed = state.handleRemovedDevices(setOf(42, 99))

        assertTrue(changed)
        assertNull(state.preferredDeviceId)
        assertEquals(
            RecordingInputFallbackReasons.DEVICE_DISCONNECTED,
            state.fallbackReason,
        )
    }
}
