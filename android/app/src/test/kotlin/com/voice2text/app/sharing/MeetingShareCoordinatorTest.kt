package com.voice2text.app.sharing

import org.junit.Assert.assertEquals
import org.junit.Test

class MeetingShareCoordinatorTest {
    @Test
    fun `transcript export extensions use explicit share mime types`() {
        assertEquals("text/plain", meetingShareMimeType("notes.txt", null))
        assertEquals("text/markdown", meetingShareMimeType("notes.md", null))
        assertEquals("application/json", meetingShareMimeType("notes.json", null))
        assertEquals("application/x-subrip", meetingShareMimeType("notes.srt", null))
        assertEquals("text/vtt", meetingShareMimeType("notes.vtt", "application/octet-stream"))
    }

    @Test
    fun `unknown extension preserves detected type and safe fallback`() {
        assertEquals("audio/mp4", meetingShareMimeType("meeting.m4a", "audio/mp4"))
        assertEquals(
            "application/octet-stream",
            meetingShareMimeType("meeting.unknown", null),
        )
    }
}
