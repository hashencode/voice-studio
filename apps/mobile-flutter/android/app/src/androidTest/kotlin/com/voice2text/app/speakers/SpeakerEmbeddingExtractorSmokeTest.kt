package com.voice2text.app.speakers

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.voice2text.app.transcription.TranscriptionCanceledException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SpeakerEmbeddingExtractorSmokeTest {
    @Test
    fun fixedAudioProducesFiniteEmbeddingAndReleasesNativeHandles() {
        assumeTrue(
            InstrumentationRegistry.getArguments()
                .getString("speakerDiarizationProbe") == "true",
        )
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val fixture = SpeakerDiarizationProbeSupport.functionalFixture(context)
        assertTrue("missing ${fixture.absolutePath}", fixture.isFile)
        val registry = SpeakerDiarizationProbeSupport.candidateRegistry(context)
        assertTrue(registry.evaluateCandidateArtifacts().isAvailable)
        val source = SpeakerPcmWindowSource(
            file = fixture,
            windowSamples = 10 * 16_000,
            overlapSamples = 0,
        )
        var firstWindow: SpeakerPcmWindow? = null
        try {
            source.readWindows(
                cancellationRequested = { firstWindow != null },
            ) {
                firstWindow = it
            }
        } catch (_: TranscriptionCanceledException) {
            // One bounded window is sufficient for the native extractor smoke.
        }
        val window = checkNotNull(firstWindow)
        val extractor = SherpaSpeakerEmbeddingExtractor(context, registry)
        val embedding = extractor.extract(window.samples)

        assertEquals(extractor.dimension, embedding?.size)
        assertTrue(checkNotNull(embedding).all(Float::isFinite))

        extractor.close()
        val closedFailure = runCatching {
            extractor.extract(window.samples)
        }.exceptionOrNull()
        assertTrue(closedFailure is IllegalStateException)
    }
}
