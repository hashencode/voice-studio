package com.voice2text.app.speakers

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SpeakerDiarizationFiveMinuteSmokeTest {
    @Test
    fun runLicensedFiveMinuteCandidateProbe() {
        assumeTrue(
            InstrumentationRegistry.getArguments()
                .getString("speakerDiarizationProbe") == "true",
        )
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val fixture = SpeakerDiarizationProbeSupport.functionalFixture(context)
        assertTrue("missing ${fixture.absolutePath}", fixture.isFile)
        assertEquals(
            SpeakerDiarizationProbeSupport.FUNCTIONAL_SHA256,
            SpeakerDiarizationProbeSupport.sha256(fixture),
        )
        val registry = SpeakerDiarizationProbeSupport.candidateRegistry(context)
        val decision = registry.evaluateCandidateArtifacts()
        assertEquals(SpeakerDiarizationGateStatus.AVAILABLE, decision.status)

        val reportFile =
            SpeakerDiarizationProbeSupport.output(
                context,
                "speaker-diarization-five-minute.json",
            )
        val inputHashBefore = SpeakerDiarizationProbeSupport.sha256(fixture)
        val transcriptSnapshot =
            "speaker-admission-transcript-sentinel/v2".toByteArray(Charsets.UTF_8)
        val transcriptHashBefore =
            SpeakerDiarizationProbeSupport.sha256(transcriptSnapshot)
        val report =
            JSONObject()
                .put("schemaVersion", 2)
                .put("source", "physical_android_instrumentation")
                .put("probe", "fiveMinute")
                .put("contractId", SpeakerDiarizationProbeSupport.contractId())
                .put("contractSha256", SpeakerDiarizationProbeSupport.contractSha256())
                .put("candidateId", SpeakerDiarizationProbeSupport.candidateId())
                .put("configuration", SpeakerDiarizationProbeSupport.configuration())
                .put("complete", false)
        reportFile.writeText(report.toString(2))
        val memory = SpeakerDiarizationProbeSupport.PeakMemorySampler().start(context)
        val started = android.os.SystemClock.elapsedRealtimeNanos()
        var samplerStopped = false
        try {
            val windowSource =
                SpeakerPcmWindowSource(
                    file = fixture,
                    windowSamples = SpeakerDiarizationProbeSupport.WINDOW_SAMPLES,
                    overlapSamples = SpeakerDiarizationProbeSupport.OVERLAP_SAMPLES,
                )
            val windowEvidence = mutableListOf<SpeakerWindowSemanticEvidence>()
            var processedWindows = 0
            var finalWindowEndSample = 0L
            var initializationNanos = 0L
            var diarizationNanos = 0L
            var embeddingNanos = 0L
            var reconciliationNanos = 0L
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
                        windowSource.readWindows { window ->
                            val result =
                                engine.processSemanticWindow(
                                    window = window,
                                    embeddingExtractor = extractor,
                                    reconciler = reconciler,
                                    numberOfSpeakers = 2,
                                )
                            windowEvidence += result.evidence
                            processedWindows += 1
                            finalWindowEndSample = window.endSampleExclusive
                            initializationNanos += result.diagnostics.initializationNanos
                            diarizationNanos += result.diagnostics.diarizationNanos
                            embeddingNanos += result.diagnostics.embeddingNanos
                            reconciliationNanos += result.diagnostics.reconciliationNanos
                        }
                    }
                }
            }
            val stitchingStarted = android.os.SystemClock.elapsedRealtimeNanos()
            val result =
                SpeakerTurnStitcher().stitch(
                    windows = windowEvidence,
                    totalSamples = windowSource.format.totalSamples,
                    sampleRate = windowSource.format.sampleRate,
                )
            val stitchingNanos =
                maxOf(
                    0L,
                    android.os.SystemClock.elapsedRealtimeNanos() - stitchingStarted,
                )
            val totalNanos =
                maxOf(0L, android.os.SystemClock.elapsedRealtimeNanos() - started)
            val measuredStageNanos =
                initializationNanos +
                    diarizationNanos +
                    embeddingNanos +
                    reconciliationNanos +
                    stitchingNanos
            val measurements = memory.stop()
            samplerStopped = true
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
                        .put("sha256", inputHashBefore)
                        .put(
                            "sha256After",
                            SpeakerDiarizationProbeSupport.sha256(fixture),
                        )
                        .put("sampleRate", windowSource.format.sampleRate)
                        .put("totalSamples", windowSource.format.totalSamples)
                        .put("consumedSamples", finalWindowEndSample),
                )
                .put(
                    "transcriptSnapshot",
                    JSONObject()
                        .put("beforeSha256", transcriptHashBefore)
                        .put(
                            "afterSha256",
                            SpeakerDiarizationProbeSupport.sha256(transcriptSnapshot),
                        ),
                )
                .put(
                    "windows",
                    JSONObject()
                        .put("planned", windowSource.plannedWindowCount)
                        .put("processed", processedWindows)
                        .put("finalWindowEndSample", finalWindowEndSample),
                )
                .put(
                    "timings",
                    JSONObject()
                        .put("initializationMs", initializationNanos / 1_000_000.0)
                        .put(
                            "pcmAndWindowingMs",
                            maxOf(0L, totalNanos - measuredStageNanos) / 1_000_000.0,
                        )
                        .put("diarizationMs", diarizationNanos / 1_000_000.0)
                        .put("embeddingMs", embeddingNanos / 1_000_000.0)
                        .put("reconciliationMs", reconciliationNanos / 1_000_000.0)
                        .put("stitchingMs", stitchingNanos / 1_000_000.0)
                        .put("totalMs", totalNanos / 1_000_000.0),
                )
                .put(
                    "semanticIntervals",
                    JSONArray(
                        result.intervals.map { interval ->
                            JSONObject()
                                .put("startSample", interval.startSample)
                                .put(
                                    "endSampleExclusive",
                                    interval.endSampleExclusive,
                                )
                                .put("kind", interval.kind.name)
                                .put(
                                    "meetingSpeakerKeys",
                                    JSONArray(interval.meetingSpeakerKeys.sorted()),
                                )
                                .put(
                                    "unknownSpeakerCount",
                                    interval.unknownSpeakerCount,
                                )
                        }
                    ),
                )
                .put("complete", true)
            reportFile.writeText(report.toString(2))
        } catch (error: Throwable) {
            val measurements =
                if (samplerStopped) {
                    null
                } else {
                    memory.stop().also { samplerStopped = true }
                }
            report
                .put(
                    "device",
                    SpeakerDiarizationProbeSupport.deviceIdentity(
                        context,
                        measurements?.maximumThermalStatusRaw
                            ?: SpeakerDiarizationProbeSupport.currentThermalStatus(context),
                    ),
                )
                .put("complete", false)
            reportFile.writeText(report.toString(2))
            throw error
        }
    }

    @Test
    fun fiveMinuteProbeIsFailClosedUntilDeviceProbesAreAdmitted() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val decision = SpeakerDiarizationModelRegistry(context).evaluate()

        assertFalse(decision.isAvailable)
        assertEquals(
            SpeakerDiarizationGateStatus.DEFERRED_FUNCTIONAL_GATE,
            decision.status,
        )
    }

    @Test
    fun productionAssetsDoNotContainUnadmittedSpeakerModels() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val rootAssets = context.assets.list("flutter_assets/assets/sherpa/speakers").orEmpty()

        assertEquals(emptyList<String>(), rootAssets.toList())
    }

    @Test
    fun unsupportedAbiFailsClosedBeforeModelInspection() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val decision = SpeakerDiarizationModelRegistry(
            context = context,
            supportedAbis = arrayOf("unsupported-test-abi"),
        ).evaluateCandidateArtifacts()

        assertEquals(SpeakerDiarizationGateStatus.UNSUPPORTED_ABI, decision.status)
    }

    @Test
    fun reviewedButMissingModelFailsClosed() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val identity = reviewedIdentity(
            assetPath = "sherpa/speakers/not-packaged.onnx",
            expectedBytes = 1,
        )
        val decision = SpeakerDiarizationModelRegistry(
            context = context,
            segmentation = identity,
            embedding = identity,
        ).evaluateCandidateArtifacts()

        assertEquals(SpeakerDiarizationGateStatus.MISSING_MODEL, decision.status)
    }

    @Test
    fun modelSizeAndHashMismatchFailClosed() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val packagedProbePath = "flutter_assets/assets/sherpa/wav/test.wav"
        val bytes = context.assets.open(packagedProbePath).use { it.readBytes() }
        val wrongSize = reviewedIdentity(
            assetPath = packagedProbePath,
            expectedBytes = bytes.size.toLong() + 1,
        )
        assertEquals(
            SpeakerDiarizationGateStatus.WRONG_MODEL_SIZE,
            SpeakerDiarizationModelRegistry(
                context = context,
                segmentation = wrongSize,
                embedding = wrongSize,
            ).evaluateCandidateArtifacts().status,
        )

        val wrongHash = reviewedIdentity(
            assetPath = packagedProbePath,
            expectedBytes = bytes.size.toLong(),
        )
        assertEquals(
            SpeakerDiarizationGateStatus.WRONG_MODEL_HASH,
            SpeakerDiarizationModelRegistry(
                context = context,
                segmentation = wrongHash,
                embedding = wrongHash,
            ).evaluateCandidateArtifacts().status,
        )
    }

    private fun reviewedIdentity(
        assetPath: String,
        expectedBytes: Long,
    ) = SpeakerModelIdentity(
        id = "instrumented-test-model",
        assetPath = assetPath,
        sourceUrl = "https://example.invalid/model",
        sourceVersion = "test",
        expectedSha256 = "0".repeat(64),
        expectedBytes = expectedBytes,
        licenseId = "test-only",
        licenseSourceUrl = "https://example.invalid/license",
        distributionReviewed = true,
    )
}
