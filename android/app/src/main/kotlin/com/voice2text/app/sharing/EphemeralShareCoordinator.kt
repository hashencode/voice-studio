package com.voice2text.app.sharing

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File

internal data class PreparedEphemeralShare(
    val path: String,
    val uri: Uri,
    val mimeType: String,
)

class EphemeralShareException(
    val code: String,
    override val message: String,
) : Exception(message)

class EphemeralShareCoordinator(
    private val context: Context,
) {
    private val root = File(context.cacheDir, EPHEMERAL_SHARE_RELATIVE_PATH)

    init {
        root.mkdirs()
    }

    fun share(path: String, displayName: String?): String {
        val prepared = prepareShare(path)
        try {
            val intent =
                Intent(Intent.ACTION_SEND).apply {
                    type = prepared.mimeType
                    putExtra(Intent.EXTRA_STREAM, prepared.uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
            context.startActivity(
                Intent.createChooser(
                    intent,
                    displayName?.takeIf { it.isNotBlank() } ?: "分享临时文件",
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: Exception) {
            File(prepared.path).delete()
            throw EphemeralShareException("EPHEMERAL_SHARE_LAUNCH_FAILED", "无法打开系统分享")
        }
        return prepared.path
    }

    internal fun prepareShare(path: String): PreparedEphemeralShare {
        val file = File(path)
        if (!file.isFile || !isWithinEphemeralShareRoot(file, root)) {
            throw EphemeralShareException(
                "EPHEMERAL_SHARE_SOURCE_INVALID",
                "临时分享文件不存在或不属于允许目录",
            )
        }
        return try {
            val uri =
                FileProvider.getUriForFile(
                    context,
                    "${context.packageName}.fileprovider",
                    file,
                )
            PreparedEphemeralShare(
                path = file.absolutePath,
                uri = uri,
                mimeType = ephemeralShareMimeType(file.name),
            )
        } catch (_: Exception) {
            throw EphemeralShareException("EPHEMERAL_SHARE_URI_FAILED", "无法创建临时只读分享链接")
        }
    }

    fun discard(path: String): Boolean {
        val file = File(path)
        if (!isWithinEphemeralShareRoot(file, root)) return false
        return !file.exists() || file.deleteRecursively()
    }

    fun cleanupStale(
        nowMs: Long = System.currentTimeMillis(),
        ttlMs: Long = EPHEMERAL_SHARE_TTL_MS,
    ): Int {
        if (!root.isDirectory) return 0
        val threshold = nowMs - ttlMs
        var removed = 0
        root.listFiles().orEmpty().forEach { child ->
            if (isStaleEphemeralChild(child, root, threshold) && child.deleteRecursively()) {
                removed += 1
            }
        }
        return removed
    }
}

internal fun ephemeralShareMimeType(fileName: String): String =
    when (fileName.substringAfterLast('.', "").lowercase()) {
        "zip" -> "application/zip"
        "json" -> "application/json"
        "txt" -> "text/plain"
        else -> "application/octet-stream"
    }

internal fun isWithinEphemeralShareRoot(
    file: File,
    root: File,
): Boolean {
    val canonicalRoot = root.canonicalFile
    val canonicalFile = file.canonicalFile
    return canonicalFile.path != canonicalRoot.path &&
        canonicalFile.path.startsWith(canonicalRoot.path + File.separator)
}

internal fun isStaleEphemeralChild(
    child: File,
    root: File,
    thresholdMs: Long,
): Boolean =
    isWithinEphemeralShareRoot(child, root) &&
        child.parentFile?.canonicalFile == root.canonicalFile &&
        child.lastModified() < thresholdMs

internal const val EPHEMERAL_SHARE_RELATIVE_PATH = "voice2text/sharing/ephemeral"
internal const val EPHEMERAL_SHARE_TTL_MS = 24L * 60L * 60L * 1000L
