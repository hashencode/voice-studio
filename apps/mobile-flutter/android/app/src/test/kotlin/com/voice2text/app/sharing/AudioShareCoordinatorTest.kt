package com.voice2text.app.sharing

import org.junit.Assert.assertEquals
import org.junit.Test

class AudioShareCoordinatorTest {
    @Test
    fun `transcript export extensions use explicit share mime types`() {
        assertEquals("text/plain", audioShareMimeType("notes.txt", null))
        assertEquals("text/markdown", audioShareMimeType("notes.md", null))
        assertEquals("application/json", audioShareMimeType("notes.json", null))
        assertEquals("application/x-subrip", audioShareMimeType("notes.srt", null))
        assertEquals("text/vtt", audioShareMimeType("notes.vtt", "application/octet-stream"))
    }

    @Test
    fun `unknown extension preserves detected type and safe fallback`() {
        assertEquals("audio/mp4", audioShareMimeType("audio.m4a", "audio/mp4"))
        assertEquals(
            "application/octet-stream",
            audioShareMimeType("audio.unknown", null),
        )
    }
}
