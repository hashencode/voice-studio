package com.voice2text.app.transcription

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineParaformerModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import kotlin.math.roundToInt

@RunWith(AndroidJUnit4::class)
class TimestampTokenGapSmokeTest {
    @Test
    fun writeNumericTokenTimestampGapsForBlindReviewClips() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val inputRoot = File(context.cacheDir, "timestamp-review")
        val outputRoot = File(context.filesDir, "device-evidence").apply { mkdirs() }
        val assets = ModelAssetManager(context)
        val model = assets.ensureParaformerExtracted("paraformer-zh")
        val recognizer =
            OfflineRecognizer(
                null as android.content.res.AssetManager?,
                OfflineRecognizerConfig(
                    featConfig = FeatureConfig(sampleRate = 16_000, featureDim = 80, dither = 0.0f),
                    modelConfig =
                        OfflineModelConfig(
                            paraformer =
                                OfflineParaformerModelConfig(
                                    model = model.modelFile.absolutePath,
                                ),
                            numThreads = 4,
                            provider = "cpu",
                            debug = false,
                            modelType = "paraformer",
                            tokens = model.tokensFile.absolutePath,
                        ),
                ),
            )
        val cases = JSONArray()
        try {
            FIXTURES.forEach { fixture ->
                val audio = File(inputRoot, "${fixture.id}.wav")
                assertTrue("missing ${fixture.id}", audio.isFile && audio.length() > 44L)
                val reader = WavPcmChunkReader(audio)
                val samples = FloatArray(reader.format.totalSamples.toInt())
                reader.readChunks { start, chunk ->
                    chunk.copyInto(samples, destinationOffset = start.toInt())
                }
                val stream = recognizer.createStream()
                val result =
                    try {
                        stream.acceptWaveform(samples, reader.format.sampleRate)
                        recognizer.decode(stream)
                        recognizer.getResult(stream)
                    } finally {
                        stream.release()
                    }
                val timestampsMs =
                    result.timestamps.map { timestamp ->
                        (timestamp * 1000.0f).roundToInt()
                    }
                val gapsMs =
                    timestampsMs.zipWithNext { first, second ->
                        second - first
                    }
                cases.put(
                    JSONObject()
                        .put("id", fixture.id)
                        .put("audioSha256", sha256(audio))
                        .put("tokenCount", result.tokens.size)
                        .put("timestampCount", timestampsMs.size)
                        .put("textSha256", sha256(result.text))
                        .put("timestampsMs", JSONArray(timestampsMs))
                        .put("gapsMs", JSONArray(gapsMs)),
                )
            }
        } finally {
            recognizer.release()
        }

        val report =
            JSONObject()
                .put("schemaVersion", 1)
                .put("source", "physical_android_paraformer_numeric_token_timestamps")
                .put("cases", cases)
        val output = File(outputRoot, "timestamp-token-gaps.json")
        output.writeText(report.toString(2))
        Log.i(TAG, "timestamp token gaps ready sha256=${sha256(output)}")
    }

    private fun sha256(file: File): String = sha256(file.readBytes())

    private fun sha256(value: String): String = sha256(value.toByteArray(Charsets.UTF_8))

    private fun sha256(bytes: ByteArray): String =
        MessageDigest
            .getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }

    private data class Fixture(
        val id: String,
    )

    private companion object {
        const val TAG = "Voice2TextDeviceTest"
        val FIXTURES =
            listOf(
                Fixture("zh_timestamp_window_000"),
                Fixture("en_timestamp_window_000"),
            )
    }
}
