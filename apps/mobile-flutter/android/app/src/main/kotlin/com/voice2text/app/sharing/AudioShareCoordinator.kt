package com.voice2text.app.sharing

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import com.voice2text.app.contracts.AudioContract
import java.io.File

internal data class PreparedAudioShare(
    val path: String,
    val uri: Uri,
    val mimeType: String,
)

class AudioShareException(
    val code: String,
    override val message: String,
) : Exception(message)

class AudioShareCoordinator(
    private val context: Context,
) {
    private val audioRoot = File(context.filesDir, AudioContract.AUDIO_DIR_NAME)
    private val exportRoot = File(audioRoot, AudioContract.EXPORT_DIR_NAME)

    init {
        exportRoot.mkdirs()
    }

    fun share(sourcePath: String, displayName: String?): String {
        val prepared = prepareShare(sourcePath, displayName)
        try {
            val intent =
                Intent(Intent.ACTION_SEND).apply {
                    type = prepared.mimeType
                    putExtra(Intent.EXTRA_STREAM, prepared.uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
            context.startActivity(
                Intent.createChooser(intent, "分享音频文件").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: Exception) {
            File(prepared.path).delete()
            throw AudioShareException("SHARE_LAUNCH_FAILED", "无法打开系统分享")
        }
        return prepared.path
    }

    internal fun prepareShare(
        sourcePath: String,
        displayName: String?,
    ): PreparedAudioShare {
        val source = File(sourcePath)
        if (!source.isFile || !isWithin(source, audioRoot) || isWithin(source, exportRoot)) {
            throw AudioShareException("SHARE_SOURCE_INVALID", "所选音频文件不可分享")
        }
        val safeName = sanitizeFileName(displayName, source)
        val target = uniqueTarget(safeName)
        try {
            source.copyTo(target, overwrite = false)
        } catch (_: Exception) {
            throw AudioShareException("SHARE_PREPARE_FAILED", "准备分享文件失败")
        }
        try {
            val uri =
                FileProvider.getUriForFile(
                    context,
                    "${context.packageName}.fileprovider",
                    target,
                )
            return PreparedAudioShare(
                path = target.absolutePath,
                uri = uri,
                mimeType =
                    audioShareMimeType(
                        target.name,
                        context.contentResolver.getType(uri),
                    ),
            )
        } catch (_: Exception) {
            target.delete()
            throw AudioShareException("SHARE_LAUNCH_FAILED", "无法打开系统分享")
        }
    }

    fun discardExport(path: String): Boolean {
        val file = File(path)
        if (!isWithin(file, exportRoot)) return false
        return !file.exists() || file.delete()
    }

    private fun sanitizeFileName(displayName: String?, source: File): String {
        val requested =
            displayName
                ?.substringAfterLast('/')
                ?.substringAfterLast('\\')
                ?.trim()
                .orEmpty()
        val fallback = source.name.takeIf { it.isNotBlank() } ?: "audio-media"
        val safe =
            (requested.takeIf { it.isNotBlank() } ?: fallback)
                .replace(Regex("[^\\p{L}\\p{N}._ -]"), "_")
                .trim('.', ' ')
                .take(120)
        val extension = source.extension.takeIf { it.isNotBlank() }
        return when {
            safe.isBlank() && extension != null -> "audio-media.$extension"
            safe.isBlank() -> "audio-media"
            extension != null && !safe.endsWith(".$extension", ignoreCase = true) -> "$safe.$extension"
            else -> safe
        }
    }

    private fun uniqueTarget(fileName: String): File {
        val base = fileName.substringBeforeLast('.', fileName)
        val extension = fileName.substringAfterLast('.', "")
        var candidate = File(exportRoot, fileName)
        var suffix = 2
        while (candidate.exists()) {
            val nextName = if (extension.isEmpty()) "$base-$suffix" else "$base-$suffix.$extension"
            candidate = File(exportRoot, nextName)
            suffix += 1
        }
        return candidate
    }

    private fun isWithin(file: File, root: File): Boolean {
        val canonicalRoot = root.canonicalFile
        val canonicalFile = file.canonicalFile
        return canonicalFile.path == canonicalRoot.path ||
            canonicalFile.path.startsWith(canonicalRoot.path + File.separator)
    }
}

internal fun audioShareMimeType(
    fileName: String,
    detectedType: String?,
): String =
    when (fileName.substringAfterLast('.', "").lowercase()) {
        "txt" -> "text/plain"
        "md" -> "text/markdown"
        "json" -> "application/json"
        "srt" -> "application/x-subrip"
        "vtt" -> "text/vtt"
        else -> detectedType ?: "application/octet-stream"
    }
