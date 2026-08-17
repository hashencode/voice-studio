package com.voice2text.app.speakers

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class SelectedFallbackSpeakerDiarizationCandidateTest {
    @Test
    fun selectedFallbackPinsOnlyTheOfficialInt8SegmentationArtifact() {
        assertEquals(
            "sherpa-v1.13.3-pyannote-int8-3dspeaker",
            SelectedFallbackSpeakerDiarizationCandidate.ID,
        )
        assertEquals(
            "d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d",
            SelectedFallbackSpeakerDiarizationCandidate.SEGMENTATION_SHA256,
        )
        assertEquals(
            1_540_506L,
            SelectedFallbackSpeakerDiarizationCandidate.SEGMENTATION_BYTES,
        )
        assertFalse(
            SelectedFallbackSpeakerDiarizationCandidate.ID ==
                "sherpa-v1.13.3-pyannote-3dspeaker",
        )
    }
}
