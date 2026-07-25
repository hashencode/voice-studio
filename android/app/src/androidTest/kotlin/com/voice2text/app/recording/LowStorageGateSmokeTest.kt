package com.voice2text.app.recording

import android.Manifest
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.voice2text.app.contracts.AudioContract
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class LowStorageGateSmokeTest {
    @Test
    fun rejectsStartBeforeCreatingRecordingArtifacts() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val sessionId = "low-storage-reject-${UUID.randomUUID()}"
        val journalRoot = File(context.cacheDir, sessionId)
        val session =
            StandardRecordingSession(
                context = context,
                journalStore = RecordingJournalStore(journalRoot),
                storageGuard = RecordingStorageGuard(availableBytesProvider = { 0L }),
            )

        val failure = runCatching { session.start(sessionId) }.exceptionOrNull()

        assertTrue(failure is RecordingSessionException)
        assertEquals("LOW_STORAGE", (failure as RecordingSessionException).code)
        assertTrue(RecordingJournalStore(journalRoot).list().isEmpty())
        assertFalse(recordingFile(context, sessionId, inProgress = true).exists())
        assertFalse(recordingFile(context, sessionId, inProgress = false).exists())
        assertTrue(journalRoot.deleteRecursively())
    }

    @Test
    fun lowReserveDuringRecordingFinalizesWithExplicitReason() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        instrumentation.uiAutomation.grantRuntimePermission(
            context.packageName,
            Manifest.permission.RECORD_AUDIO,
        )
        val sessionId = "low-storage-active-${UUID.randomUUID()}"
        val journalRoot = File(context.cacheDir, sessionId)
        var availableBytes = AudioContract.MINIMUM_STORAGE_RESERVE_BYTES * 2
        val session =
            StandardRecordingSession(
                context = context,
                journalStore = RecordingJournalStore(journalRoot),
                storageGuard =
                    RecordingStorageGuard(
                        availableBytesProvider = { availableBytes },
                    ),
            )
        var started = false
        try {
            session.start(sessionId)
            started = true
            Thread.sleep(1_500)

            val telemetry = session.telemetrySnapshot()
            assertTrue(telemetry.amplitude in 0..RecordingTelemetrySampler.MAX_AMPLITUDE)
            assertTrue(
                telemetry.status == RecordingTelemetryStatuses.AVAILABLE ||
                    telemetry.status == RecordingTelemetryStatuses.SILENT,
            )
            assertTrue(telemetry.isAvailable)
            assertTrue(telemetry.deviceType in SUPPORTED_DEVICE_TYPES)

            availableBytes = 0L
            assertFalse(session.hasSafeStorageReserve())
            val result = session.stop("low_storage")
            started = false

            assertEquals(RecordingStates.COMPLETED, result.state)
            assertEquals("low_storage", result.stopReason)
            assertTrue(File(result.path).isFile)
            assertTrue(File(result.path).length() > 0L)
        } finally {
            if (started) {
                runCatching { session.stop("test_cleanup") }
            }
            recordingFile(context, sessionId, inProgress = true).delete()
            recordingFile(context, sessionId, inProgress = false).delete()
            RecordingJournalStore(journalRoot).delete(sessionId)
            journalRoot.deleteRecursively()
        }
    }

    private fun recordingFile(
        context: android.content.Context,
        sessionId: String,
        inProgress: Boolean,
    ): File {
        val recordingRoot =
            File(
                File(context.filesDir, AudioContract.MEETING_DIR_NAME),
                AudioContract.RECORDING_DIR_NAME,
            )
        val directory =
            if (inProgress) {
                AudioContract.RECORDING_IN_PROGRESS_DIR_NAME
            } else {
                AudioContract.RECORDING_COMPLETE_DIR_NAME
            }
        val extension =
            if (inProgress) {
                AudioContract.RECORDING_STAGING_EXTENSION
            } else {
                AudioContract.RECORDING_EXTENSION
        }
        return File(File(recordingRoot, directory), "record-$sessionId.$extension")
    }

    private companion object {
        val SUPPORTED_DEVICE_TYPES =
            setOf(
                RecordingInputDeviceTypes.BUILT_IN,
                RecordingInputDeviceTypes.WIRED,
                RecordingInputDeviceTypes.BLUETOOTH,
                RecordingInputDeviceTypes.USB,
                RecordingInputDeviceTypes.EXTERNAL,
            )
    }
}
