package com.voice2text.app.recording

import android.content.Context
import android.media.MediaMetadataRetriever
import com.voice2text.app.contracts.AudioContract
import java.io.File

interface RecordingAssetValidator {
    fun durationMs(file: File): Long?

    fun isPlayable(file: File): Boolean = durationMs(file)?.let { it > 0L } == true
}

class MediaRecordingAssetValidator : RecordingAssetValidator {
    override fun durationMs(file: File): Long? {
        if (!file.isFile || file.length() <= 0L) return null
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(file.absolutePath)
            retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull()
                ?.takeIf { it > 0L }
        } catch (_: Exception) {
            null
        } finally {
            runCatching { retriever.release() }
        }
    }
}

data class RecordingRecoveryCandidate(
    val sessionId: String,
    val state: String,
    val stagingPath: String,
    val canonicalPath: String,
    val durationMs: Long,
    val createdAtMs: Long,
    val stopReason: String?,
    val errorCategory: String?,
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "sessionId" to sessionId,
        "state" to state,
        "stagingPath" to stagingPath,
        "canonicalPath" to canonicalPath,
        "durationMs" to durationMs,
        "createdAtMs" to createdAtMs,
        "stopReason" to stopReason,
        "errorCategory" to errorCategory,
    )
}

class RecordingRecoveryManager(
    private val journalStore: RecordingJournalStore,
    private val inProgressRoot: File,
    private val completeRoot: File,
    private val validator: RecordingAssetValidator,
) {
    constructor(context: Context) : this(
        journalStore = RecordingJournalStore(context),
        inProgressRoot = File(
            File(
                File(context.filesDir, AudioContract.AUDIO_DIR_NAME),
                AudioContract.RECORDING_DIR_NAME,
            ),
            AudioContract.RECORDING_IN_PROGRESS_DIR_NAME,
        ),
        completeRoot = File(
            File(
                File(context.filesDir, AudioContract.AUDIO_DIR_NAME),
                AudioContract.RECORDING_DIR_NAME,
            ),
            AudioContract.RECORDING_COMPLETE_DIR_NAME,
        ),
        validator = MediaRecordingAssetValidator(),
    )

    init {
        inProgressRoot.mkdirs()
        completeRoot.mkdirs()
    }

    @Synchronized
    fun scan(): List<RecordingRecoveryCandidate> {
        val candidates = mutableListOf<RecordingRecoveryCandidate>()
        val knownStagingPaths = mutableSetOf<String>()

        journalStore.list().forEach { journal ->
            knownStagingPaths += File(journal.stagingPath).absolutePath
            if (journal.state == RecordingStates.COMPLETED || journal.state == RecordingStates.DISCARDED) {
                return@forEach
            }
            val canonical = File(journal.canonicalPath)
            val staging = File(journal.stagingPath)
            val playable = when {
                validator.isPlayable(canonical) -> canonical
                validator.isPlayable(staging) -> staging
                else -> null
            }
            candidates += RecordingRecoveryCandidate(
                sessionId = journal.sessionId,
                state = if (playable == null) RecordingStates.INVALID else RecordingStates.RECOVERABLE,
                stagingPath = journal.stagingPath,
                canonicalPath = journal.canonicalPath,
                durationMs = playable?.let { validator.durationMs(it) } ?: journal.elapsedMs(),
                createdAtMs = journal.createdAtMs,
                stopReason = journal.stopReason ?: "process_interrupted",
                errorCategory = if (playable == null) "invalid_media" else journal.errorCategory,
            )
        }

        inProgressRoot
            .listFiles { file -> file.isFile && file.name.endsWith(".partial") }
            .orEmpty()
            .filterNot { it.absolutePath in knownStagingPaths }
            .forEach { orphan ->
                candidates += RecordingRecoveryCandidate(
                    sessionId = "orphan-${orphan.nameWithoutExtension}",
                    state = if (validator.isPlayable(orphan)) RecordingStates.RECOVERABLE else RecordingStates.INVALID,
                    stagingPath = orphan.absolutePath,
                    canonicalPath = File(
                        completeRoot,
                        orphan.name.removeSuffix(".partial"),
                    ).absolutePath,
                    durationMs = validator.durationMs(orphan) ?: 0L,
                    createdAtMs = orphan.lastModified(),
                    stopReason = "journal_missing",
                    errorCategory = if (validator.isPlayable(orphan)) null else "invalid_media",
                )
            }
        return candidates.sortedBy { it.createdAtMs }
    }

    @Synchronized
    fun latestCompleted(): RecordingRecoveryCandidate? =
        journalStore
            .list()
            .asReversed()
            .firstNotNullOfOrNull { journal ->
                if (journal.state != RecordingStates.COMPLETED) {
                    return@firstNotNullOfOrNull null
                }
                val canonical = File(journal.canonicalPath)
                val durationMs = validator.durationMs(canonical)
                    ?: return@firstNotNullOfOrNull null
                RecordingRecoveryCandidate(
                    sessionId = journal.sessionId,
                    state = RecordingStates.COMPLETED,
                    stagingPath = journal.stagingPath,
                    canonicalPath = journal.canonicalPath,
                    durationMs = durationMs,
                    createdAtMs = journal.createdAtMs,
                    stopReason = journal.stopReason,
                    errorCategory = null,
                )
            }

    @Synchronized
    fun recover(sessionId: String): RecordingSessionResult {
        val candidate = scan().firstOrNull { it.sessionId == sessionId }
            ?: throw RecordingSessionException("RECOVERY_NOT_FOUND", "未找到可恢复的录音")
        val source = when {
            validator.isPlayable(File(candidate.canonicalPath)) -> File(candidate.canonicalPath)
            validator.isPlayable(File(candidate.stagingPath)) -> File(candidate.stagingPath)
            else -> throw RecordingSessionException("INVALID_MEDIA", "临时录音不可播放，只能安全清理")
        }
        val target = File(candidate.canonicalPath)
        target.parentFile?.mkdirs()
        if (source.absolutePath != target.absolutePath) {
            if (target.exists() && !target.delete()) {
                throw RecordingSessionException("FINALIZE_FAILED", "恢复目标文件已存在且无法替换")
            }
            if (!source.renameTo(target)) {
                throw RecordingSessionException("FINALIZE_FAILED", "临时录音无法提交到正式存储")
            }
        }
        val durationMs = validator.durationMs(target)
            ?: throw RecordingSessionException("INVALID_MEDIA", "恢复后的录音不可播放")
        val now = System.currentTimeMillis()
        val previous = journalStore.read(sessionId)
        if (previous != null) {
            journalStore.write(
                previous.copy(
                    state = RecordingStates.COMPLETED,
                    accumulatedMs = durationMs,
                    activeSinceMs = null,
                    updatedAtMs = now,
                    stopReason = previous.stopReason ?: "recovered",
                    errorCategory = null,
                ),
            )
        }
        return RecordingSessionResult(
            sessionId = sessionId,
            path = target.absolutePath,
            durationMs = durationMs.toInt(),
            state = RecordingStates.COMPLETED,
            stopReason = previous?.stopReason ?: "recovered",
        )
    }

    @Synchronized
    fun discard(sessionId: String): Boolean {
        val candidate = scan().firstOrNull { it.sessionId == sessionId } ?: return true
        val stagingDeleted = deleteIfPresent(File(candidate.stagingPath))
        val canonicalDeleted = deleteIfPresent(File(candidate.canonicalPath))
        if (!stagingDeleted || !canonicalDeleted) return false

        val previous = journalStore.read(sessionId)
        if (previous == null) {
            return true
        }
        journalStore.write(
            previous.copy(
                state = RecordingStates.DISCARDED,
                activeSinceMs = null,
                updatedAtMs = System.currentTimeMillis(),
                stopReason = previous.stopReason ?: "user_discarded",
            ),
        )
        return true
    }

    private fun deleteIfPresent(file: File): Boolean = !file.exists() || file.delete()
}

object RecordingStates {
    const val PREPARING = "preparing"
    const val RECORDING = "recording"
    const val PAUSED = "paused"
    const val FINALIZING = "finalizing"
    const val COMPLETED = "completed"
    const val RECOVERABLE = "recoverable"
    const val INVALID = "invalid"
    const val FAILED = "failed"
    const val DISCARDED = "discarded"
    const val IDLE = "idle"
}
