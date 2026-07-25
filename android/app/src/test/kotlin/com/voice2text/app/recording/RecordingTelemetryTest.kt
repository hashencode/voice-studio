package com.voice2text.app.recording

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingTelemetryTest {
    @Test
    fun recordingSamplesAreBoundedAndClassified() {
        val sampler =
            RecordingTelemetrySampler {
                RawRecordingTelemetry(
                    amplitude = 40_000,
                    deviceType = RecordingInputDeviceTypes.BLUETOOTH,
                )
            }

        val snapshot = sampler.snapshot(RecordingStates.RECORDING)

        assertEquals(RecordingTelemetryStatuses.AVAILABLE, snapshot.status)
        assertEquals(32_767, snapshot.amplitude)
        assertEquals(RecordingInputDeviceTypes.BLUETOOTH, snapshot.deviceType)
        assertTrue(snapshot.isAvailable)
    }

    @Test
    fun zeroAmplitudeIsAnHonestSilentSample() {
        val snapshot =
            RecordingTelemetrySampler {
                RawRecordingTelemetry(
                    amplitude = 0,
                    deviceType = RecordingInputDeviceTypes.BUILT_IN,
                )
            }.snapshot(RecordingStates.RECORDING)

        assertEquals(RecordingTelemetryStatuses.SILENT, snapshot.status)
        assertEquals(0, snapshot.amplitude)
        assertTrue(snapshot.isAvailable)
    }

    @Test
    fun pausedAndInactiveStatesDoNotReadTheRecorder() {
        var calls = 0
        val sampler =
            RecordingTelemetrySampler {
                calls += 1
                RawRecordingTelemetry(1, RecordingInputDeviceTypes.BUILT_IN)
            }

        val paused = sampler.snapshot(RecordingStates.PAUSED)
        val inactive = sampler.snapshot(RecordingStates.COMPLETED)

        assertEquals(0, calls)
        assertEquals(RecordingTelemetryStatuses.PAUSED, paused.status)
        assertEquals(RecordingTelemetryStatuses.UNKNOWN, inactive.status)
        assertEquals(0, paused.amplitude)
        assertFalse(paused.isAvailable)
        assertNull(inactive.deviceType)
    }

    @Test
    fun recorderFailuresBecomeUnknownWithoutEscaping() {
        val sampler =
            RecordingTelemetrySampler {
                throw IllegalStateException("recorder unavailable")
            }

        val snapshot = sampler.snapshot(RecordingStates.RECORDING)

        assertEquals(RecordingTelemetryStatuses.UNKNOWN, snapshot.status)
        assertEquals(0, snapshot.amplitude)
        assertNull(snapshot.deviceType)
        assertFalse(snapshot.isAvailable)
    }

    @Test
    fun missingRouteDoesNotPretendToUseTheBuiltInMicrophone() {
        val snapshot =
            RecordingTelemetrySampler {
                RawRecordingTelemetry(amplitude = 7, deviceType = null)
            }.snapshot(RecordingStates.RECORDING)

        assertEquals(RecordingTelemetryStatuses.UNKNOWN, snapshot.status)
        assertNull(snapshot.deviceType)
        assertFalse(snapshot.isAvailable)
    }
}
