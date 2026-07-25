package com.voice2text.app.transcription

import android.os.Build
import android.os.Debug
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizerResult
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.k2fsa.sherpa.onnx.WaveData
import com.k2fsa.sherpa.onnx.WaveReader
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import kotlin.math.min

@RunWith(AndroidJUnit4::class)
class OnlineTransducerCandidateSmokeTest {
    @Test
    fun testPinnedCandidateBaselineAndHotwordDecode() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.filesDir, "online-transducer-candidate")
        val outputRoot = File(context.filesDir, "device-evidence").apply { mkdirs() }
        val modelFiles =
            ModelFiles(
                encoder = File(root, ENCODER),
                decoder = File(root, DECODER),
                joiner = File(root, JOINER),
                tokens = File(root, TOKENS),
            )
        val audio = File(root, AUDIO)
        val hotwords = File(root, HOTWORDS)
        (modelFiles.all + audio + hotwords).forEach { file ->
            assertTrue("missing ${file.absolutePath}", file.isFile && file.length() > 0)
        }
        assertTrue("candidate audio hash mismatch", sha256(audio) == AUDIO_SHA256)
        assertTrue("candidate hotwords hash mismatch", sha256(hotwords) == HOTWORDS_SHA256)

        val wave = WaveReader.readWave(audio.absolutePath)
        val runs =
            JSONArray()
                .put(
                    decode(
                        id = "baseline",
                        modelFiles = modelFiles,
                        wave = wave,
                        hotwordsFile = null,
                    ),
                ).put(
                    decode(
                        id = "hotword_score_1_5",
                        modelFiles = modelFiles,
                        wave = wave,
                        hotwordsFile = hotwords,
                    ),
                )
        val report =
            JSONObject()
                .put("schemaVersion", 1)
                .put("source", "physical_android_instrumentation")
                .put("candidateId", CANDIDATE_ID)
                .put("deviceSerialClass", "mid")
                .put("manufacturer", Build.MANUFACTURER)
                .put("model", Build.MODEL)
                .put("sdkInt", Build.VERSION.SDK_INT)
                .put("audio", AUDIO)
                .put("audioSha256", sha256(audio))
                .put("audioDurationSec", wave.samples.size.toDouble() / wave.sampleRate)
                .put("decoderMethod", DECODING_METHOD)
                .put("modelingUnit", MODELING_UNIT)
                .put("maxActivePaths", MAX_ACTIVE_PATHS)
                .put("hotwordsFileSha256", sha256(hotwords))
                .put("hotwordsScore", HOTWORDS_SCORE.toDouble())
                .put(
                    "modelFiles",
                    JSONObject()
                        .put("encoderSha256", sha256(modelFiles.encoder))
                        .put("decoderSha256", sha256(modelFiles.decoder))
                        .put("joinerSha256", sha256(modelFiles.joiner))
                        .put("tokensSha256", sha256(modelFiles.tokens))
                        .put("totalBytes", modelFiles.all.sumOf { it.length() }),
                )
                .put("runs", runs)
        val output = File(outputRoot, "online-transducer-candidate.json")
        output.writeText(report.toString(2))
    }

    private fun decode(
        id: String,
        modelFiles: ModelFiles,
        wave: WaveData,
        hotwordsFile: File?,
    ): JSONObject {
        val javaBefore = javaHeapUsed()
        val nativeBefore = Debug.getNativeHeapAllocatedSize()
        var peakJava = javaBefore
        var peakNative = nativeBefore
        val loadStarted = SystemClock.elapsedRealtimeNanos()
        val recognizer =
            OnlineRecognizer(
                null,
                OnlineRecognizerConfig(
                    featConfig =
                        FeatureConfig(
                            sampleRate = wave.sampleRate,
                            featureDim = 80,
                            dither = 0.0f,
                        ),
                    modelConfig =
                        OnlineModelConfig(
                            transducer =
                                OnlineTransducerModelConfig(
                                    encoder = modelFiles.encoder.absolutePath,
                                    decoder = modelFiles.decoder.absolutePath,
                                    joiner = modelFiles.joiner.absolutePath,
                                ),
                            tokens = modelFiles.tokens.absolutePath,
                            numThreads = NUM_THREADS,
                            debug = false,
                            provider = "cpu",
                            modelType = "zipformer",
                            modelingUnit = MODELING_UNIT,
                        ),
                    enableEndpoint = false,
                    decodingMethod = DECODING_METHOD,
                    maxActivePaths = MAX_ACTIVE_PATHS,
                    hotwordsFile = hotwordsFile?.absolutePath.orEmpty(),
                    hotwordsScore = HOTWORDS_SCORE,
                ),
            )
        val loadMs = elapsedMs(loadStarted)
        var stream: OnlineStream? = null
        val decodeStarted = SystemClock.elapsedRealtimeNanos()
        val cpuStarted = Debug.threadCpuTimeNanos()
        val result: OnlineRecognizerResult
        try {
            stream = recognizer.createStream()
            val chunkSamples = (wave.sampleRate / 10).coerceAtLeast(1)
            var start = 0
            while (start < wave.samples.size) {
                val end = min(start + chunkSamples, wave.samples.size)
                stream.acceptWaveform(wave.samples.copyOfRange(start, end), wave.sampleRate)
                while (recognizer.isReady(stream)) recognizer.decode(stream)
                peakJava = maxOf(peakJava, javaHeapUsed())
                peakNative = maxOf(peakNative, Debug.getNativeHeapAllocatedSize())
                start = end
            }
            stream.inputFinished()
            while (recognizer.isReady(stream)) recognizer.decode(stream)
            result = recognizer.getResult(stream)
            peakJava = maxOf(peakJava, javaHeapUsed())
            peakNative = maxOf(peakNative, Debug.getNativeHeapAllocatedSize())
        } finally {
            try {
                stream?.release()
            } catch (_: Exception) {
            }
            try {
                recognizer.release()
            } catch (_: Exception) {
            }
        }
        val wallMs = elapsedMs(decodeStarted)
        val durationSec = wave.samples.size.toDouble() / wave.sampleRate
        val scores = result.ysProbs
        return JSONObject()
            .put("id", id)
            .put("hotwordsEnabled", hotwordsFile != null)
            .put("loadMs", loadMs)
            .put("decodeWallMs", wallMs)
            .put("decodeCpuMs", (Debug.threadCpuTimeNanos() - cpuStarted) / 1_000_000L)
            .put("rtf", wallMs / 1000.0 / durationSec)
            .put("javaHeapBeforeBytes", javaBefore)
            .put("peakSampledJavaHeapBytes", peakJava)
            .put("nativeHeapBeforeBytes", nativeBefore)
            .put("peakSampledNativeHeapBytes", peakNative)
            .put("text", result.text.trim())
            .put("tokens", JSONArray(result.tokens.toList()))
            .put("timestamps", JSONArray(result.timestamps.toList()))
            .put("ysProbs", JSONArray(scores.toList()))
            .put("tokenCount", result.tokens.size)
            .put("timestampCount", result.timestamps.size)
            .put("ysProbsCount", scores.size)
            .put("ysProbsMin", scores.minOrNull()?.toDouble() ?: JSONObject.NULL)
            .put("ysProbsMax", scores.maxOrNull()?.toDouble() ?: JSONObject.NULL)
    }

    private fun javaHeapUsed(): Long {
        val runtime = Runtime.getRuntime()
        return runtime.totalMemory() - runtime.freeMemory()
    }

    private fun elapsedMs(started: Long): Long =
        (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000L

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private data class ModelFiles(
        val encoder: File,
        val decoder: File,
        val joiner: File,
        val tokens: File,
    ) {
        val all = listOf(encoder, decoder, joiner, tokens)
    }

    private companion object {
        const val CANDIDATE_ID = "streaming-zipformer-zh-14m-2023-02-23"
        const val ENCODER = "encoder-epoch-99-avg-1.int8.onnx"
        const val DECODER = "decoder-epoch-99-avg-1.int8.onnx"
        const val JOINER = "joiner-epoch-99-avg-1.int8.onnx"
        const val TOKENS = "tokens.txt"
        const val AUDIO = "zh.wav"
        const val AUDIO_SHA256 = "9345f80fc835ae2afc9bb58ccdbd5047797d7de3afc4cb3a2c6ef44444a2a562"
        const val HOTWORDS = "online_candidate_hotwords.txt"
        const val HOTWORDS_SHA256 = "22a1bcfb2c756b24d022bd33942a0a2ba24489a1d9e3818d2d8e5c6b5769e611"
        const val NUM_THREADS = 4
        const val MODELING_UNIT = "cjkchar"
        const val DECODING_METHOD = "modified_beam_search"
        const val MAX_ACTIVE_PATHS = 4
        const val HOTWORDS_SCORE = 1.5f
    }
}
