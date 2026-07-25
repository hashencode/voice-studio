package com.voice2text.app.recording

import android.content.Context
import com.voice2text.app.contracts.AudioContract
import org.json.JSONObject
import java.io.File

data class RecordingJournal(
    val sessionId: String,
    val state: String,
    val stagingPath: String,
    val canonicalPath: String,
    val accumulatedMs: Long,
    val activeSinceMs: Long?,
    val createdAtMs: Long,
    val updatedAtMs: Long,
    val stopReason: String?,
    val errorCategory: String?,
) {
    fun elapsedMs(nowMs: Long = System.currentTimeMillis()): Long {
        val activeMs = activeSinceMs?.let { (nowMs - it).coerceAtLeast(0L) } ?: 0L
        return accumulatedMs + activeMs
    }

    fun toMap(): Map<String, Any?> = mapOf(
        "sessionId" to sessionId,
        "state" to state,
        "stagingPath" to stagingPath,
        "canonicalPath" to canonicalPath,
        "durationMs" to elapsedMs(),
        "createdAtMs" to createdAtMs,
        "updatedAtMs" to updatedAtMs,
        "stopReason" to stopReason,
        "errorCategory" to errorCategory,
    )
}

class RecordingJournalStore(
    private val journalRoot: File,
) {
    constructor(context: Context) : this(
        File(
            File(context.filesDir, AudioContract.MEETING_DIR_NAME),
            AudioContract.RECORDING_JOURNAL_DIR_NAME,
        ),
    )

    init {
        journalRoot.mkdirs()
    }

    @Synchronized
    fun write(journal: RecordingJournal) {
        journalRoot.mkdirs()
        val target = journalFile(journal.sessionId)
        val temporary = File(journalRoot, "${journal.sessionId}.journal.json.tmp")
        temporary.writeText(journal.toJson().toString())
        if (target.exists() && !target.delete()) {
            temporary.delete()
            throw IllegalStateException("journal_replace_failed")
        }
        if (!temporary.renameTo(target)) {
            temporary.delete()
            throw IllegalStateException("journal_commit_failed")
        }
    }

    @Synchronized
    fun read(sessionId: String): RecordingJournal? {
        val file = journalFile(sessionId)
        if (!file.isFile) return null
        return runCatching { JSONObject(file.readText()).toRecordingJournal() }.getOrNull()
    }

    @Synchronized
    fun list(): List<RecordingJournal> {
        if (!journalRoot.isDirectory) return emptyList()
        return journalRoot
            .listFiles { file -> file.isFile && file.name.endsWith(".journal.json") }
            .orEmpty()
            .mapNotNull { file ->
                runCatching { JSONObject(file.readText()).toRecordingJournal() }.getOrNull()
            }
            .sortedBy { it.createdAtMs }
    }

    @Synchronized
    fun delete(sessionId: String): Boolean {
        val target = journalFile(sessionId)
        return !target.exists() || target.delete()
    }

    fun root(): File = journalRoot

    private fun journalFile(sessionId: String): File =
        File(journalRoot, "$sessionId${AudioContract.RECORDING_JOURNAL_SUFFIX}")
}

private fun RecordingJournal.toJson(): JSONObject = JSONObject().apply {
    put("sessionId", sessionId)
    put("state", state)
    put("stagingPath", stagingPath)
    put("canonicalPath", canonicalPath)
    put("accumulatedMs", accumulatedMs)
    if (activeSinceMs == null) put("activeSinceMs", JSONObject.NULL) else put("activeSinceMs", activeSinceMs)
    put("createdAtMs", createdAtMs)
    put("updatedAtMs", updatedAtMs)
    if (stopReason == null) put("stopReason", JSONObject.NULL) else put("stopReason", stopReason)
    if (errorCategory == null) put("errorCategory", JSONObject.NULL) else put("errorCategory", errorCategory)
}

private fun JSONObject.toRecordingJournal(): RecordingJournal = RecordingJournal(
    sessionId = getString("sessionId"),
    state = getString("state"),
    stagingPath = getString("stagingPath"),
    canonicalPath = getString("canonicalPath"),
    accumulatedMs = optLong("accumulatedMs", 0L),
    activeSinceMs = optionalLong("activeSinceMs"),
    createdAtMs = getLong("createdAtMs"),
    updatedAtMs = getLong("updatedAtMs"),
    stopReason = optionalString("stopReason"),
    errorCategory = optionalString("errorCategory"),
)

private fun JSONObject.optionalLong(name: String): Long? =
    if (!has(name) || isNull(name)) null else getLong(name)

private fun JSONObject.optionalString(name: String): String? =
    if (!has(name) || isNull(name)) null else getString(name)
