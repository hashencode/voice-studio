package com.voice2text.app.importing

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.voice2text.app.contracts.AudioContract
import java.io.File
import java.security.MessageDigest
import java.util.UUID

data class ImportedMediaResult(
    val path: String,
    val displayName: String,
    val mimeType: String?,
    val sizeBytes: Long,
    val durationMs: Long,
    val fingerprintSha256: String,
    val duplicateAsset: Boolean,
) {
    fun toMap(): Map<String, Any?> =
        mapOf(
            "path" to path,
            "displayName" to displayName,
            "mimeType" to mimeType,
            "sizeBytes" to sizeBytes,
            "durationMs" to durationMs,
            "fingerprintSha256" to fingerprintSha256,
            "duplicateAsset" to duplicateAsset,
        )
}

class DocumentImportCoordinator(
    private val context: Context,
    private val inspector: ImportedMediaInspector = ImportedMediaInspector(context),
) {
    private val audioRoot = File(context.filesDir, AudioContract.AUDIO_DIR_NAME)
    private val stagingRoot =
        File(File(audioRoot, AudioContract.IMPORT_DIR_NAME), AudioContract.IMPORT_IN_PROGRESS_DIR_NAME)
    private val completeRoot =
        File(File(audioRoot, AudioContract.IMPORT_DIR_NAME), AudioContract.IMPORT_COMPLETE_DIR_NAME)

    init {
        stagingRoot.mkdirs()
        completeRoot.mkdirs()
    }

    @Volatile
    private var cancelRequested = false

    fun prepareImportRequest() {
        cancelRequested = false
    }

    fun cancelActiveImport() {
        cancelRequested = true
    }

    fun pickerIntent(): Intent =
        Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "audio/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("audio/*", "video/*"))
        }

    fun import(uri: Uri): ImportedMediaResult {
        ensureNotCancelled()
        val metadata = inspector.inspect(uri)
        ensureNotCancelled()
        ensureStorageReserve(metadata.sizeBytes.coerceAtLeast(0L))
        val staging = File(stagingRoot, "import-${UUID.randomUUID()}.partial")
        val digest = MessageDigest.getInstance("SHA-256")
        var copiedBytes = 0L
        try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                staging.outputStream().buffered().use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        ensureNotCancelled()
                        val count = input.read(buffer)
                        if (count < 0) break
                        ensureNotCancelled()
                        copiedBytes += count
                        if (copiedBytes > AudioContract.MAXIMUM_IMPORTED_MEDIA_BYTES) {
                            throw ImportedMediaException(
                                "FILE_LIMIT_EXCEEDED",
                                "媒体文件不能超过 2 GiB",
                            )
                        }
                        if (audioRoot.usableSpace < AudioContract.MINIMUM_STORAGE_RESERVE_BYTES) {
                            throw ImportedMediaException(
                                "LOW_STORAGE",
                                "存储空间不足，导入已安全停止",
                            )
                        }
                        digest.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                    }
                }
            } ?: throw ImportedMediaException("UNREADABLE_MEDIA", "无法读取所选媒体")
            if (copiedBytes <= 0L) {
                throw ImportedMediaException("UNREADABLE_MEDIA", "所选媒体内容为空")
            }
            val fingerprint = digest.digest().joinToString("") { "%02x".format(it) }
            val extension = safeExtension(metadata.displayName, metadata.mimeType)
            val target = File(completeRoot, "import-$fingerprint.$extension")
            val duplicate = target.isFile && target.length() == copiedBytes
            if (duplicate) {
                staging.delete()
            } else {
                if (target.exists() && !target.delete()) {
                    throw ImportedMediaException("IMPORT_COMMIT_FAILED", "无法替换未完成的导入文件")
                }
                if (!staging.renameTo(target)) {
                    throw ImportedMediaException("IMPORT_COMMIT_FAILED", "无法提交导入文件")
                }
            }
            return ImportedMediaResult(
                path = target.absolutePath,
                displayName = metadata.displayName,
                mimeType = metadata.mimeType,
                sizeBytes = copiedBytes,
                durationMs = metadata.durationMs,
                fingerprintSha256 = fingerprint,
                duplicateAsset = duplicate,
            )
        } catch (error: ImportedMediaException) {
            staging.delete()
            throw error
        } catch (_: SecurityException) {
            staging.delete()
            throw ImportedMediaException("SOURCE_PERMISSION_REVOKED", "媒体读取权限已失效，请重新选择")
        } catch (_: Exception) {
            staging.delete()
            throw ImportedMediaException("IMPORT_COPY_FAILED", "复制媒体到本机失败")
        }
    }

    fun discard(path: String): Boolean {
        val file = File(path)
        if (!isWithin(file, completeRoot)) return false
        return !file.exists() || file.delete()
    }

    fun cleanupStaging(): Int {
        var deleted = 0
        stagingRoot
            .listFiles { file -> file.isFile && file.name.endsWith(".partial") }
            .orEmpty()
            .forEach { file ->
                if (file.delete()) deleted += 1
            }
        return deleted
    }

    private fun ensureStorageReserve(sourceBytes: Long) {
        val required = sourceBytes + AudioContract.MINIMUM_STORAGE_RESERVE_BYTES
        if (audioRoot.usableSpace < required) {
            throw ImportedMediaException("LOW_STORAGE", "存储空间不足，无法安全导入媒体")
        }
    }

    private fun ensureNotCancelled() {
        if (cancelRequested) {
            throw ImportedMediaException("IMPORT_CANCELLED", "导入已取消")
        }
    }

    private fun safeExtension(displayName: String, mimeType: String?): String {
        val fromName =
            displayName
                .substringAfterLast('.', "")
                .lowercase()
                .takeIf { it.matches(Regex("[a-z0-9]{1,8}")) }
        if (fromName != null) return fromName
        return when {
            mimeType == "audio/mpeg" -> "mp3"
            mimeType == "audio/mp4" -> "m4a"
            mimeType == "audio/wav" || mimeType == "audio/x-wav" -> "wav"
            mimeType?.startsWith("video/") == true -> "mp4"
            else -> "media"
        }
    }

    private fun isWithin(file: File, root: File): Boolean {
        val canonicalRoot = root.canonicalFile
        val canonicalFile = file.canonicalFile
        return canonicalFile.path == canonicalRoot.path ||
            canonicalFile.path.startsWith(canonicalRoot.path + File.separator)
    }
}
