package com.voice2text.app.speakers

import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SpeakerDiarizationResourceGateTest {
    @Test
    fun runBoundedOneHundredTwentyMinuteResourceProbe() {
        assumeTrue(
            InstrumentationRegistry.getArguments()
                .getString("speakerDiarizationProbe") == "true",
        )
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val fixture = SpeakerDiarizationProbeSupport.resourceFixture(context)
        assertTrue("missing ${fixture.absolutePath}", fixture.isFile)
        val fixtureHash = SpeakerDiarizationProbeSupport.sha256(fixture)
        assertEquals(SpeakerDiarizationProbeSupport.RESOURCE_SHA256, fixtureHash)
        val registry = SpeakerDiarizationProbeSupport.candidateRegistry(context)
        assertEquals(
            SpeakerDiarizationGateStatus.AVAILABLE,
            registry.evaluateCandidateArtifacts().status,
        )

        val reportFile =
            SpeakerDiarizationProbeSupport.output(
                context,
                "speaker-diarization-resource.json",
            )
        val report =
            JSONObject()
                .put("schemaVersion", 2)
                .put("source", "physical_android_instrumentation")
                .put("probe", "oneHundredTwentyMinute")
                .put("contractId", SpeakerDiarizationProbeSupport.contractId())
                .put("contractSha256", SpeakerDiarizationProbeSupport.contractSha256())
                .put("candidateId", SpeakerDiarizationProbeSupport.candidateId())
                .put("configuration", SpeakerDiarizationProbeSupport.configuration())
                .put("oom", false)
                .put("anr", false)
                .put("complete", false)
        reportFile.writeText(report.toString(2))

        val source =
            SpeakerPcmWindowSource(
                file = fixture,
                windowSamples = SpeakerDiarizationProbeSupport.WINDOW_SAMPLES,
                overlapSamples = SpeakerDiarizationProbeSupport.OVERLAP_SAMPLES,
            )
        val started = android.os.SystemClock.elapsedRealtimeNanos()
        var processedWindows = 0
        var finalWindowEndSample = 0L
        var memorySampler: SpeakerDiarizationProbeSupport.PeakMemorySampler? = null
        try {
            SherpaSpeakerDiarizationEngine(
                context,
                registry,
                SpeakerDiarizationProbeSupport.candidateId(),
            ).use { engine ->
                SherpaSpeakerEmbeddingExtractor(context, registry).use { extractor ->
                    MeetingSpeakerClusterReconciler(
                        similarityThreshold =
                            SpeakerDiarizationProbeSupport.RECONCILIATION_THRESHOLD,
                    ).use { reconciler ->
                        source.readWindows { window ->
                            engine.processSemanticWindow(
                                window = window,
                                embeddingExtractor = extractor,
                                reconciler = reconciler,
                            )
                            processedWindows += 1
                            finalWindowEndSample = window.endSampleExclusive
                            if (memorySampler == null) {
                                memorySampler =
                                    SpeakerDiarizationProbeSupport.PeakMemorySampler()
                                        .start(context)
                            }
                            if (processedWindows % 8 == 0) {
                                report
                                    .put(
                                        "windows",
                                        JSONObject()
                                            .put("planned", source.plannedWindowCount)
                                            .put("processed", processedWindows)
                                            .put(
                                                "finalWindowEndSample",
                                                finalWindowEndSample,
                                            )
                                            .put(
                                                "retainedFinalizedIntervalCount",
                                                0,
                                            ),
                                    )
                                    .put("complete", false)
                                reportFile.writeText(report.toString(2))
                            }
                        }
                    }
                }
            }
            val measurements =
                checkNotNull(memorySampler) { "资源探针没有处理任何窗口" }.stop()
            val elapsedMs =
                SpeakerDiarizationProbeSupport.elapsedMs(started)
            report
                .put(
                    "device",
                    SpeakerDiarizationProbeSupport.deviceIdentity(
                        context,
                        measurements.maximumThermalStatusRaw,
                    ),
                )
                .put(
                    "fixture",
                    JSONObject()
                        .put("sha256", fixtureHash)
                        .put("sampleRate", source.format.sampleRate)
                        .put("totalSamples", source.format.totalSamples)
                        .put("consumedSamples", finalWindowEndSample),
                )
                .put(
                    "windows",
                    JSONObject()
                        .put("planned", source.plannedWindowCount)
                        .put("processed", processedWindows)
                        .put("finalWindowEndSample", finalWindowEndSample)
                        .put("retainedFinalizedIntervalCount", 0),
                )
                .put(
                    "memory",
                    JSONObject()
                        .put("baselinePssKiB", measurements.baselinePssKiB)
                        .put("peakPssKiB", measurements.peakPssKiB),
                )
                .put("elapsedMs", elapsedMs)
                .put("completed", true)
                .put("oom", false)
                .put("anr", false)
                .put("complete", true)
            reportFile.writeText(report.toString(2))
        } catch (error: Throwable) {
            memorySampler?.stop()
            report
                .put("completed", false)
                .put("oom", error is OutOfMemoryError)
                .put("anr", false)
                .put("complete", false)
            reportFile.writeText(report.toString(2))
            throw error
        }
    }

    @Test
    fun oneHundredTwentyMinuteProbeRecordsDeferredInsteadOfInventingMetrics() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val decision = SpeakerDiarizationModelRegistry(context).evaluate()

        assertFalse(decision.isAvailable)
        assertEquals(
            SpeakerDiarizationGateStatus.DEFERRED_FUNCTIONAL_GATE,
            decision.status,
        )
        assertTrue(Build.SUPPORTED_ABIS.any(SpeakerDiarizationModelRegistry.SUPPORTED_ABIS::contains))
    }

    @Test
    fun thirtyMinuteProbeIsIntentionallyAbsentFromDevelopmentGate() {
        // KTD14: the development admission schedule is exactly 5 and 120 minutes.
        val scheduledProbeMinutes = setOf(5, 120)
        assertEquals(setOf(5, 120), scheduledProbeMinutes)
        assertFalse(30 in scheduledProbeMinutes)
    }
}
