package com.voice2text.app.importing

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.OpenableColumns
import com.voice2text.app.contracts.AudioContract

data class ImportedMediaMetadata(
    val displayName: String,
    val mimeType: String?,
    val sizeBytes: Long,
    val durationMs: Long,
    val hasAudioTrack: Boolean,
)

class ImportedMediaException(
    val code: String,
    override val message: String,
) : Exception(message)

class ImportedMediaInspector(
    private val context: Context,
) {
    fun inspect(uri: Uri): ImportedMediaMetadata =
        try {
            inspectReadableMedia(uri)
        } catch (error: ImportedMediaException) {
            throw error
        } catch (_: SecurityException) {
            throw ImportedMediaException(
                "SOURCE_PERMISSION_REVOKED",
                "媒体读取权限已失效，请重新选择",
            )
        } catch (_: Exception) {
            throw ImportedMediaException("UNREADABLE_MEDIA", "无法读取所选媒体")
        }

    private fun inspectReadableMedia(uri: Uri): ImportedMediaMetadata {
        val resolver = context.contentResolver
        val displayNameAndSize =
            resolver
                .query(
                    uri,
                    arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                    null,
                    null,
                    null,
                )?.use { cursor ->
                    if (!cursor.moveToFirst()) {
                        null
                    } else {
                        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                        Pair(
                            if (nameIndex >= 0) cursor.getString(nameIndex) else null,
                            if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                                cursor.getLong(sizeIndex)
                            } else {
                                -1L
                            },
                        )
                    }
                }
        val retriever = MediaMetadataRetriever()
        val durationMs: Long
        val hasAudioTrack: Boolean
        try {
            retriever.setDataSource(context, uri)
            durationMs =
                retriever
                    .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                    ?.toLongOrNull()
                    ?: 0L
            hasAudioTrack =
                retriever
                    .extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO)
                    ?.equals("yes", ignoreCase = true)
                    ?: false
        } finally {
            runCatching { retriever.release() }
        }
        val metadata =
            ImportedMediaMetadata(
                displayName = sanitizeDisplayName(displayNameAndSize?.first),
                mimeType = resolver.getType(uri),
                sizeBytes =
                    displayNameAndSize?.second?.takeIf { it >= 0L }
                        ?: resolver.openAssetFileDescriptor(uri, "r")?.use { it.length }
                        ?: -1L,
                durationMs = durationMs,
                hasAudioTrack = hasAudioTrack,
            )
        validate(metadata)
        return metadata
    }

    companion object {
        fun validate(metadata: ImportedMediaMetadata) {
            if (!metadata.hasAudioTrack || metadata.durationMs <= 0L) {
                throw ImportedMediaException("NO_AUDIO_TRACK", "所选媒体不包含可用音轨")
            }
            if (metadata.durationMs > AudioContract.MAXIMUM_IMPORTED_DURATION_MS) {
                throw ImportedMediaException("DURATION_LIMIT_EXCEEDED", "媒体时长不能超过 4 小时")
            }
            if (metadata.sizeBytes > AudioContract.MAXIMUM_IMPORTED_MEDIA_BYTES) {
                throw ImportedMediaException("FILE_LIMIT_EXCEEDED", "媒体文件不能超过 2 GiB")
            }
        }

        fun sanitizeDisplayName(raw: String?): String {
            val leaf =
                raw
                    ?.substringAfterLast('/')
                    ?.substringAfterLast('\\')
                    ?.trim()
                    .orEmpty()
            return leaf.takeIf { it.isNotEmpty() }?.take(160) ?: "导入媒体"
        }
    }
}
