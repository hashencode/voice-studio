package com.voice2text.app.speakers

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SelectedFallbackSpeakerDiarizationSmokeTest {
    @Test
    fun runSelectedFallbackFiveMinuteProbe() {
        assertEquals(
            SelectedFallbackSpeakerDiarizationCandidate.ID,
            InstrumentationRegistry.getArguments()
                .getString("speakerDiarizationCandidate"),
        )
        SpeakerDiarizationFiveMinuteSmokeTest().runLicensedFiveMinuteCandidateProbe()
    }
}
