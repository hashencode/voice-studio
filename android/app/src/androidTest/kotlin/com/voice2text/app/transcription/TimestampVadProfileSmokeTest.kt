package com.voice2text.app.transcription

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import kotlin.math.roundToInt

@RunWith(AndroidJUnit4::class)
class TimestampVadProfileSmokeTest {
    @Test
    fun writeNumericBoundarySweepForBlindReviewClips() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val inputRoot = File(context.cacheDir, "timestamp-review")
        val outputRoot = File(context.filesDir, "device-evidence").apply { mkdirs() }
        val vadModel = ModelAssetManager(context).ensureVadExtracted()
        val cases = JSONArray()

        FIXTURES.forEach { fixture ->
            val audio = File(inputRoot, "${fixture.id}.wav")
            assertTrue("missing ${fixture.id}", audio.isFile && audio.length() > 44L)
            val reader = WavPcmChunkReader(audio)
            val profiles = JSONArray()
            PROFILES.forEach { profile ->
                profiles.put(runProfile(reader, vadModel, profile))
            }
            cases.put(
                JSONObject()
                    .put("id", fixture.id)
                    .put("audioSha256", sha256(audio))
                    .put("durationMs", fixture.durationMs)
                    .put("profiles", profiles),
            )
        }

        val report =
            JSONObject()
                .put("schemaVersion", 1)
                .put("source", "physical_android_silero_vad_numeric_sweep")
                .put("cases", cases)
        val output = File(outputRoot, "timestamp-vad-sweep.json")
        output.writeText(report.toString(2))
        Log.i(TAG, "timestamp VAD sweep ready sha256=${sha256(output)}")
    }

    private fun runProfile(
        reader: WavPcmChunkReader,
        vadModel: File,
        profile: Profile,
    ): JSONObject {
        val sampleRate = reader.format.sampleRate
        val vad =
            Vad(
                null as android.content.res.AssetManager?,
                VadModelConfig(
                    sileroVadModelConfig =
                        SileroVadModelConfig(
                            model = vadModel.absolutePath,
                            threshold = profile.threshold,
                            minSilenceDuration = profile.minSilenceSec,
                            minSpeechDuration = profile.minSpeechSec,
                            windowSize = VAD_WINDOW_SIZE,
                            maxSpeechDuration = profile.maxSpeechSec,
                        ),
                    sampleRate = sampleRate,
                    numThreads = 1,
                    provider = "cpu",
                    debug = false,
                ),
            )
        val segments = JSONArray()
        try {
            fun drain() {
                while (!vad.empty()) {
                    val speech = vad.front()
                    val startMs = samplesToMs(speech.start, sampleRate)
                    val endMs = samplesToMs(speech.start + speech.samples.size, sampleRate)
                    segments.put(
                        JSONObject()
                            .put("sequenceId", segments.length())
                            .put("startMs", startMs)
                            .put("endMs", endMs),
                    )
                    vad.pop()
                }
            }
            reader.readChunks(maxSamplesPerChunk = sampleRate) { _, samples ->
                vad.acceptWaveform(samples)
                drain()
            }
            vad.flush()
            drain()
        } finally {
            vad.release()
        }
        return JSONObject()
            .put("id", profile.id)
            .put("threshold", profile.threshold.toDouble())
            .put("minSilenceSec", profile.minSilenceSec.toDouble())
            .put("minSpeechSec", profile.minSpeechSec.toDouble())
            .put("maxSpeechSec", profile.maxSpeechSec.toDouble())
            .put("segmentCount", segments.length())
            .put("segments", segments)
    }

    private fun samplesToMs(samples: Int, sampleRate: Int): Int =
        (samples.toDouble() * 1000.0 / sampleRate).roundToInt()

    private fun sha256(file: File): String =
        MessageDigest
            .getInstance("SHA-256")
            .digest(file.readBytes())
            .joinToString("") { "%02x".format(it) }

    private data class Fixture(
        val id: String,
        val durationMs: Int,
    )

    private data class Profile(
        val id: String,
        val threshold: Float,
        val minSilenceSec: Float,
        val minSpeechSec: Float,
        val maxSpeechSec: Float,
    )

    private companion object {
        const val TAG = "Voice2TextDeviceTest"
        const val VAD_WINDOW_SIZE = 512
        val FIXTURES =
            listOf(
                Fixture("zh_timestamp_window_000", 20_000),
                Fixture("en_timestamp_window_000", 18_000),
            )
        val PROFILES =
            listOf(
                Profile("production", 0.15f, 0.20f, 0.25f, 5.0f),
                Profile("threshold_020", 0.20f, 0.25f, 0.25f, 5.0f),
                Profile("threshold_035", 0.35f, 0.25f, 0.25f, 5.0f),
                Profile("threshold_050", 0.50f, 0.25f, 0.25f, 5.0f),
                Profile("silence_050", 0.20f, 0.50f, 0.25f, 5.0f),
                Profile("max_speech_030", 0.20f, 0.25f, 0.25f, 3.0f),
            )
    }
}
