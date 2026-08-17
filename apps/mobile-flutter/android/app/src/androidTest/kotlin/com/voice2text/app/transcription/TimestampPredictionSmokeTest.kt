package com.voice2text.app.transcription

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest

@RunWith(AndroidJUnit4::class)
class TimestampPredictionSmokeTest {
    @Test
    fun testProductionPredictionsFromBlindReviewClips() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val inputRoot = File(context.cacheDir, "timestamp-review")
        val outputRoot = File(context.filesDir, "device-evidence").apply { mkdirs() }
        val engine = RealSherpaTranscriptionEngine(context)
        val cases = JSONArray()

        FIXTURES.forEach { fixture ->
            val audio = File(inputRoot, "${fixture.id}.wav")
            assertTrue("missing ${fixture.id}", audio.isFile && audio.length() > 44L)
            val result =
                engine.transcribe(
                    TranscriptionRequest(
                        recordingPath = audio.absolutePath,
                        durationMs = fixture.durationMs,
                        modelId = "paraformer-zh",
                        sampleRateHz = 16_000,
                        enablePunctuation = false,
                        enableDenoise = false,
                    ),
                )
            val segments = JSONArray()
            result.segments.forEach { segment ->
                segments.put(
                    JSONObject()
                        .put("sequenceId", segment.sequenceId)
                        .put("startMs", segment.startMs)
                        .put("endMs", segment.endMs),
                )
            }
            cases.put(
                JSONObject()
                    .put("id", fixture.id)
                    .put("audioSha256", sha256(audio))
                    .put("segments", segments),
            )
            Log.i(
                TAG,
                "timestamp prediction case=${fixture.id} " +
                    "segments=${result.segments.size} audioSha256=${sha256(audio)}",
            )
        }

        val report =
            JSONObject()
                .put("schemaVersion", 2)
                .put("source", "physical_android_production_engine")
                .put("modelId", "paraformer-zh")
                .put(
                    "segmentationContract",
                    JSONObject()
                        .put("boundarySource", "silero_vad_then_adaptive_energy")
                        .put("sampleRateHz", 16_000)
                        .put("sileroThreshold", 0.15)
                        .put("sileroMinSilenceDurationSec", 0.20)
                        .put("sileroMinSpeechDurationSec", 0.25)
                        .put("sileroMaxSpeechDurationSec", 5.0)
                        .put("adaptiveFrameDurationMs", 20)
                        .put("adaptiveMinSilenceDurationMs", 400)
                        .put("adaptiveMinSpeechDurationMs", 250)
                        .put("adaptiveEndPaddingMs", 20)
                        .put("adaptiveDynamicRangeFraction", 0.20),
                )
                .put("cases", cases)
        val output = File(outputRoot, "timestamp-predictions.json")
        output.writeText(report.toString(2))
        Log.i(TAG, "timestamp predictions ready sha256=${sha256(output)}")
    }

    private fun sha256(file: File): String =
        MessageDigest
            .getInstance("SHA-256")
            .digest(file.readBytes())
            .joinToString("") { "%02x".format(it) }

    private data class Fixture(
        val id: String,
        val durationMs: Int,
    )

    private companion object {
        const val TAG = "Voice2TextDeviceTest"
        val FIXTURES =
            listOf(
                Fixture("zh_timestamp_window_000", 20_000),
                Fixture("en_timestamp_window_000", 18_000),
            )
    }
}
