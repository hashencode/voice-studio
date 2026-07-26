package com.voice2text.app.speakers

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SpeakerDiarizationFinalDiagnosticTest {
    @Test
    fun runOfficialParityArm() {
        assumeTrue(
            InstrumentationRegistry.getArguments()
                .getString("speakerDiarizationFinalDiagnostic") == "true",
        )
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val armId = SpeakerDiarizationProbeSupport.finalDiagnosticArmId()
        val threads = SpeakerDiarizationProbeSupport.finalDiagnosticThreads(armId)
        val fixture = SpeakerDiarizationProbeSupport.functionalFixture(context)
        assertTrue("missing ${fixture.absolutePath}", fixture.isFile)
        assertEquals(
            SpeakerDiarizationProbeSupport.FUNCTIONAL_SHA256,
            SpeakerDiarizationProbeSupport.sha256(fixture),
        )
        val registry = SpeakerDiarizationProbeSupport.finalDiagnosticRegistry(context, armId)
        assertEquals(
            SpeakerDiarizationGateStatus.AVAILABLE,
            registry.evaluateCandidateArtifacts().status,
        )
        val reportFile =
            SpeakerDiarizationProbeSupport.output(
                context,
                "speaker-diarization-final-$armId.json",
            )
        val inputHashBefore = SpeakerDiarizationProbeSupport.sha256(fixture)
        val transcriptSnapshot =
            "speaker-final-diagnostic-transcript-sentinel/v1".toByteArray(Charsets.UTF_8)
        val transcriptHashBefore =
            SpeakerDiarizationProbeSupport.sha256(transcriptSnapshot)
        val report =
            JSONObject()
                .put("schemaVersion", 1)
                .put("source", "physical_android_instrumentation")
                .put("contractId", SpeakerDiarizationProbeSupport.FINAL_DIAGNOSTIC_CONTRACT_ID)
                .put("armId", armId)
                .put("complete", false)
        reportFile.writeText(report.toString(2))

        val completeFixture = SpeakerDiarizationProbeSupport.readCompleteFixture(fixture)
        assertEquals(16_000, completeFixture.sampleRate)
        val memory = SpeakerDiarizationProbeSupport.PeakMemorySampler().start(context)
        val started = android.os.SystemClock.elapsedRealtimeNanos()
        var samplerStopped = false
        try {
            val turns =
                SherpaSpeakerDiarizationEngine(
                    context = context,
                    registry = registry,
                    candidateId = armId,
                ).use { engine ->
                    engine.processFullFixtureForDiagnostic(
                        samples = completeFixture.samples,
                        numThreads = threads,
                    )
                }
            val elapsedNanos =
                maxOf(0L, android.os.SystemClock.elapsedRealtimeNanos() - started)
            val measurements = memory.stop()
            samplerStopped = true
            val elapsedMs = elapsedNanos / 1_000_000.0
            val durationSeconds =
                completeFixture.totalSamples.toDouble() / completeFixture.sampleRate
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
                        .put("sampleRate", completeFixture.sampleRate)
                        .put("totalSamples", completeFixture.totalSamples)
                        .put("consumedSamples", completeFixture.totalSamples),
                )
                .put(
                    "configuration",
                    SpeakerDiarizationProbeSupport.finalDiagnosticConfiguration(
                        armId,
                        registry,
                    ),
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
                    "timings",
                    JSONObject()
                        .put("elapsedMs", elapsedMs)
                        .put("rtf", elapsedMs / 1_000.0 / durationSeconds),
                )
                .put(
                    "resources",
                    JSONObject()
                        .put("baselinePssKiB", measurements.baselinePssKiB)
                        .put("peakPssKiB", measurements.peakPssKiB)
                        .put("peakJavaBytes", measurements.peakJavaBytes)
                        .put("peakNativeBytes", measurements.peakNativeBytes),
                )
                .put(
                    "turns",
                    JSONArray(
                        turns.map { turn ->
                            JSONObject()
                                .put("startSeconds", turn.startSeconds)
                                .put("endSeconds", turn.endSeconds)
                                .put("speakerIndex", turn.speakerIndex)
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
                .put("failureClass", error.javaClass.simpleName)
            reportFile.writeText(report.toString(2))
            throw error
        }
    }
}
