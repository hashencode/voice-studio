package com.voice2text.app.importing

import com.voice2text.app.contracts.AudioContract
import org.junit.Assert.assertEquals
import org.junit.Test

class ImportedMediaInspectorTest {
    @Test
    fun validAudioMetadataPasses() {
        ImportedMediaInspector.validate(
            ImportedMediaMetadata(
                displayName = "audio.m4a",
                mimeType = "audio/mp4",
                sizeBytes = 1024L,
                durationMs = 60_000L,
                hasAudioTrack = true,
            ),
        )
    }

    @Test
    fun rejectsMissingAudioOversizeAndOverlongMedia() {
        assertCode(
            "NO_AUDIO_TRACK",
            ImportedMediaMetadata("video.mp4", "video/mp4", 1024L, 1000L, false),
        )
        assertCode(
            "FILE_LIMIT_EXCEEDED",
            ImportedMediaMetadata(
                "large.wav",
                "audio/wav",
                AudioContract.MAXIMUM_IMPORTED_MEDIA_BYTES + 1L,
                1000L,
                true,
            ),
        )
        assertCode(
            "DURATION_LIMIT_EXCEEDED",
            ImportedMediaMetadata(
                "long.wav",
                "audio/wav",
                1024L,
                AudioContract.MAXIMUM_IMPORTED_DURATION_MS + 1L,
                true,
            ),
        )
    }

    @Test
    fun displayNameCannotEscapeManagedDirectory() {
        assertEquals(
            "audio.mp3",
            ImportedMediaInspector.sanitizeDisplayName("../../audio.mp3"),
        )
        assertEquals(
            "audio.mp3",
            ImportedMediaInspector.sanitizeDisplayName("..\\..\\audio.mp3"),
        )
        assertEquals("导入媒体", ImportedMediaInspector.sanitizeDisplayName("  "))
    }

    private fun assertCode(code: String, metadata: ImportedMediaMetadata) {
        val error = runCatching { ImportedMediaInspector.validate(metadata) }.exceptionOrNull()
        assertEquals(code, (error as ImportedMediaException).code)
    }
}
