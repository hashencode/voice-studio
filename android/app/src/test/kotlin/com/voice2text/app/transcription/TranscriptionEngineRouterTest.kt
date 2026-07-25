package com.voice2text.app.transcription

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptionEngineRouterTest {
    @Test
    fun resolveAlwaysReturnsTheConfiguredRealEngine() {
        val engine =
            object : TranscriptionEngine {
                override fun transcribe(
                    request: TranscriptionRequest,
                    executionContext: TranscriptionExecutionContext,
                ): TranscriptionResult = TranscriptionResult.singleText("real", 1000)
            }

        val router = TranscriptionEngineRouter(engine)

        assertSame(engine, router.resolve())
        assertSame(engine, router.resolve())
    }

    @Test
    fun paraformerCapabilityGatesDistinguishPresenceFromVerification() {
        val descriptor = TranscriptionModelRegistry.descriptorFor("paraformer-zh")

        assertFalse(descriptor.itn.available)
        assertFalse(descriptor.itn.verified)
        assertEquals("itn_asset_missing", descriptor.itn.reason)

        assertFalse(descriptor.confidence.available)
        assertFalse(descriptor.confidence.verified)
        assertEquals("recognizer_confidence_unavailable", descriptor.confidence.reason)

        assertFalse(descriptor.hotwords.available)
        assertFalse(descriptor.hotwords.verified)
        assertEquals("paraformer_hotwords_unsupported", descriptor.hotwords.reason)

        assertTrue(descriptor.enhancement.available)
        assertFalse(descriptor.enhancement.verified)
        assertEquals("enhancement_benchmark_pending", descriptor.enhancement.reason)
        assertEquals(descriptor.enhancement.verified, descriptor.denoiseReady)
    }

    @Test
    fun unknownModelIdUsesTheSameConservativeCapabilityGates() {
        val defaultDescriptor = TranscriptionModelRegistry.models.first()
        val fallbackDescriptor = TranscriptionModelRegistry.descriptorFor("unknown-model")

        assertSame(defaultDescriptor, fallbackDescriptor)
        assertFalse(fallbackDescriptor.itn.verified)
        assertFalse(fallbackDescriptor.confidence.verified)
        assertFalse(fallbackDescriptor.hotwords.verified)
        assertFalse(fallbackDescriptor.enhancement.verified)
    }
}
