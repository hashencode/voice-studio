package com.voice2text.app.recording

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class RecordingRecoveryManagerTest {
    private lateinit var root: File
    private lateinit var journalStore: RecordingJournalStore
    private lateinit var inProgressRoot: File
    private lateinit var completeRoot: File
    private lateinit var validator: FakeRecordingAssetValidator
    private lateinit var manager: RecordingRecoveryManager

    @Before
    fun setUp() {
        root = Files.createTempDirectory("recording-recovery-test").toFile()
        journalStore = RecordingJournalStore(File(root, "journals"))
        inProgressRoot = File(root, "in-progress")
        completeRoot = File(root, "complete")
        validator = FakeRecordingAssetValidator()
        manager =
            RecordingRecoveryManager(
                journalStore = journalStore,
                inProgressRoot = inProgressRoot,
                completeRoot = completeRoot,
                validator = validator,
            )
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    @Test
    fun scanClassifiesPlayableAndInvalidJournalAssets() {
        val playable =
            File(inProgressRoot, "record-playable.m4a.partial").apply {
                parentFile?.mkdirs()
                writeBytes(byteArrayOf(1))
            }
        validator.setDuration(playable, 4_200L)
        writeJournal(
            sessionId = "playable",
            staging = playable,
            canonical = File(completeRoot, "record-playable.m4a"),
            createdAtMs = 10L,
        )
        val invalid =
            File(inProgressRoot, "record-invalid.m4a.partial").apply {
                writeBytes(byteArrayOf())
            }
        writeJournal(
            sessionId = "invalid",
            staging = invalid,
            canonical = File(completeRoot, "record-invalid.m4a"),
            createdAtMs = 20L,
        )

        val candidates = manager.scan()

        assertEquals(listOf("playable", "invalid"), candidates.map { it.sessionId })
        assertEquals(RecordingStates.RECOVERABLE, candidates[0].state)
        assertEquals(4_200L, candidates[0].durationMs)
        assertEquals(RecordingStates.INVALID, candidates[1].state)
        assertEquals("invalid_media", candidates[1].errorCategory)
    }

    @Test
    fun scanFindsOrphanPartialWithoutJournal() {
        val orphan =
            File(inProgressRoot, "record-orphan.m4a.partial").apply {
                parentFile?.mkdirs()
                writeBytes(byteArrayOf(1, 2))
                setLastModified(30L)
            }
        validator.setDuration(orphan, 2_000L)

        val candidate = manager.scan().single()

        assertTrue(candidate.sessionId.startsWith("orphan-"))
        assertEquals("journal_missing", candidate.stopReason)
        assertEquals(RecordingStates.RECOVERABLE, candidate.state)
    }

    @Test
    fun recoverMovesPlayableStagingAssetAndCompletesJournal() {
        val staging =
            File(inProgressRoot, "record-session.m4a.partial").apply {
                parentFile?.mkdirs()
                writeBytes(byteArrayOf(7))
            }
        val canonical = File(completeRoot, "record-session.m4a")
        validator.setDuration(staging, 9_000L)
        validator.setDuration(canonical, 9_000L)
        writeJournal(
            sessionId = "session",
            staging = staging,
            canonical = canonical,
            createdAtMs = 10L,
        )

        val result = manager.recover("session")

        assertEquals(RecordingStates.COMPLETED, result.state)
        assertEquals(9_000, result.durationMs)
        assertFalse(staging.exists())
        assertTrue(canonical.exists())
        assertEquals(RecordingStates.COMPLETED, journalStore.read("session")?.state)
    }

    @Test
    fun invalidAssetCannotBeRecoveredButCanBeDiscardedIdempotently() {
        val staging =
            File(inProgressRoot, "record-invalid.m4a.partial").apply {
                parentFile?.mkdirs()
                writeBytes(byteArrayOf())
            }
        writeJournal(
            sessionId = "invalid",
            staging = staging,
            canonical = File(completeRoot, "record-invalid.m4a"),
            createdAtMs = 10L,
        )

        val error = runCatching { manager.recover("invalid") }.exceptionOrNull()
        assertEquals("INVALID_MEDIA", (error as RecordingSessionException).code)
        assertTrue(manager.discard("invalid"))
        assertTrue(manager.discard("invalid"))
        assertFalse(staging.exists())
        assertEquals(RecordingStates.DISCARDED, journalStore.read("invalid")?.state)
    }

    @Test
    fun latestCompletedRebuildsDurableSnapshotAfterProcessRestart() {
        val olderCanonical =
            File(completeRoot, "record-older.m4a").apply {
                parentFile?.mkdirs()
                writeBytes(byteArrayOf(1))
            }
        val latestCanonical =
            File(completeRoot, "record-latest.m4a").apply {
                writeBytes(byteArrayOf(2))
            }
        validator.setDuration(olderCanonical, 2_000L)
        validator.setDuration(latestCanonical, 9_000L)
        writeCompletedJournal(
            sessionId = "older",
            canonical = olderCanonical,
            createdAtMs = 10L,
        )
        writeCompletedJournal(
            sessionId = "latest",
            canonical = latestCanonical,
            createdAtMs = 20L,
            stopReason = "notification_stop",
        )

        val completed = manager.latestCompleted()

        assertEquals("latest", completed?.sessionId)
        assertEquals(RecordingStates.COMPLETED, completed?.state)
        assertEquals(9_000L, completed?.durationMs)
        assertEquals("notification_stop", completed?.stopReason)
        assertTrue(manager.scan().isEmpty())
    }

    private fun writeJournal(
        sessionId: String,
        staging: File,
        canonical: File,
        createdAtMs: Long,
    ) {
        journalStore.write(
            RecordingJournal(
                sessionId = sessionId,
                state = RecordingStates.RECORDING,
                stagingPath = staging.absolutePath,
                canonicalPath = canonical.absolutePath,
                accumulatedMs = 1_000L,
                activeSinceMs = null,
                createdAtMs = createdAtMs,
                updatedAtMs = createdAtMs,
                stopReason = null,
                errorCategory = null,
            ),
        )
    }

    private fun writeCompletedJournal(
        sessionId: String,
        canonical: File,
        createdAtMs: Long,
        stopReason: String = "user_stop",
    ) {
        journalStore.write(
            RecordingJournal(
                sessionId = sessionId,
                state = RecordingStates.COMPLETED,
                stagingPath = File(inProgressRoot, "record-$sessionId.m4a.partial").absolutePath,
                canonicalPath = canonical.absolutePath,
                accumulatedMs = 1_000L,
                activeSinceMs = null,
                createdAtMs = createdAtMs,
                updatedAtMs = createdAtMs,
                stopReason = stopReason,
                errorCategory = null,
            ),
        )
    }
}

private class FakeRecordingAssetValidator : RecordingAssetValidator {
    private val durations = mutableMapOf<String, Long>()

    fun setDuration(file: File, durationMs: Long) {
        durations[file.absolutePath] = durationMs
    }

    override fun durationMs(file: File): Long? =
        durations[file.absolutePath]?.takeIf { file.isFile && file.length() > 0L }
}
