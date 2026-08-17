package com.voice2text.app.privacy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class PrivacySafeLogTest {
    @Test
    fun `formatter keeps allowlisted metadata and redacts unsafe values`() {
        val formatted =
            PrivacySafeLog.format(
                event = "transcribe_failed",
                fields =
                    mapOf(
                        "jobId" to 7,
                        "stage" to "decode",
                        "category" to "/data/user/0/private/audio.m4a",
                        "uri" to "content://provider/private",
                    ),
            )

        assertEquals(
            "event=transcribe_failed category=redacted jobId=7 stage=decode",
            formatted,
        )
        assertFalse(formatted.contains("/data/"))
        assertFalse(formatted.contains("content://"))
    }

    @Test
    fun `formatter rejects an unsafe event name`() {
        assertEquals(
            "event=invalid_event",
            PrivacySafeLog.format("meeting title: confidential"),
        )
    }
}
