package com.voice2text.app.transcription

import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.Debug
import android.os.PowerManager
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.k2fsa.sherpa.onnx.WaveReader
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.DataOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

@RunWith(AndroidJUnit4::class)
class SpeechEnhancementPairedGateTest {
    @Test
    fun testPreregisteredRawAndEnhancedPairs() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val inputRoot = File(context.filesDir, "s2-noise")
        val outputRoot = File(context.filesDir, "device-evidence").apply { mkdirs() }
        val model = ModelAssetManager(context).ensureSpeechEnhancementExtracted()
        assertEquals(MODEL_BYTES, model.length())
        assertEquals(MODEL_SHA256, sha256(model))
        val before = deviceState(context)
        val cases = JSONArray()
        val output = File(outputRoot, "speech-enhancement-paired-gate.json")
        SpeechEnhancementProcessor.create(model, numThreads = 1).use { processor ->
            CASE_IDS.forEach { caseId ->
                val input = File(inputRoot, "$caseId.wav")
                assertTrue("missing ${input.absolutePath}", input.isFile && input.length() > 44L)
                cases.put(runPair(context, caseId, input, processor))
                output.writeText(
                    buildReport(
                        before = before,
                        after = null,
                        cases = cases,
                        complete = false,
                    ).toString(2),
                )
            }
        }
        val after = deviceState(context)
        output.writeText(
            buildReport(
                before = before,
                after = after,
                cases = cases,
                complete = true,
            ).toString(2),
        )
    }

    private fun buildReport(
        before: JSONObject,
        after: JSONObject?,
        cases: JSONArray,
        complete: Boolean,
    ): JSONObject =
        JSONObject()
            .put("schemaVersion", 1)
            .put("source", "physical_android_instrumentation")
            .put("modelId", "paraformer-zh")
            .put("enhancementModel", "gtcrn_simple.onnx")
            .put("enhancementModelSha256", MODEL_SHA256)
            .put("deviceClass", "mid")
            .put("manufacturer", Build.MANUFACTURER)
            .put("model", Build.MODEL)
            .put("sdkInt", Build.VERSION.SDK_INT)
            .put("complete", complete)
            .put("completedCaseCount", cases.length())
            .put("deviceStateBefore", before)
            .put("deviceStateAfter", after ?: JSONObject.NULL)
            .put("cases", cases)

    private fun runPair(
        context: Context,
        caseId: String,
        input: File,
        processor: SpeechEnhancementProcessor,
    ): JSONObject {
        val inputHashBefore = sha256(input)
        val wave = WaveReader.readWave(input.absolutePath)
        val durationSec = wave.samples.size.toDouble() / wave.sampleRate
        val runtime = Runtime.getRuntime()
        val javaHeapBefore = runtime.totalMemory() - runtime.freeMemory()
        val nativeHeapBefore = Debug.getNativeHeapAllocatedSize()
        val memory = PeakMemorySampler().apply { start() }
        val raw: JSONObject
        val enhancementMs: Long
        val enhancedSampleCount: Int
        val enhancedFile: File
        val enhancedResult: JSONObject
        try {
            raw = transcribe(context, input, durationSec)
            val enhancementStarted = SystemClock.elapsedRealtimeNanos()
            val enhanced = processor.process(wave.samples, wave.sampleRate)
            enhancementMs = elapsedMs(enhancementStarted)
            enhancedSampleCount = enhanced.samples.size
            enhancedFile = File(context.cacheDir, "enhanced-$caseId.wav")
            writePcm16Wav(enhancedFile, enhanced.samples, enhanced.sampleRate)
            enhancedResult = transcribe(context, enhancedFile, durationSec)
        } catch (error: Throwable) {
            memory.stopAndSnapshot()
            throw error
        }
        val memoryResult = memory.stopAndSnapshot()
        val inputHashAfter = sha256(input)
        assertEquals("enhancement mutated source $caseId", inputHashBefore, inputHashAfter)
        val result =
            JSONObject()
                .put("id", caseId)
                .put("inputSha256", inputHashBefore)
                .put("inputDurationSec", durationSec)
                .put("inputSamples", wave.samples.size)
                .put("enhancedSha256", sha256(enhancedFile))
                .put("enhancedSamples", enhancedSampleCount)
                .put("enhancementMs", enhancementMs)
                .put("enhancementRtf", enhancementMs / 1000.0 / durationSec)
                .put("raw", raw)
                .put("enhanced", enhancedResult)
                .put(
                    "combinedEnhancedRtf",
                    (enhancementMs + enhancedResult.optLong("transcriptionMs")) /
                        1000.0 /
                        durationSec,
                )
                .put("javaHeapBeforeBytes", javaHeapBefore)
                .put("nativeHeapBeforeBytes", nativeHeapBefore)
                .put("peakSampledJavaHeapBytes", memoryResult.first)
                .put("peakSampledNativeHeapBytes", memoryResult.second)
                .put("sourcePreserved", inputHashBefore == inputHashAfter)
        enhancedFile.delete()
        return result
    }

    private fun transcribe(
        context: Context,
        audio: File,
        durationSec: Double,
    ): JSONObject {
        val started = SystemClock.elapsedRealtimeNanos()
        return try {
            val result =
                RealSherpaTranscriptionEngine(context).transcribe(
                    TranscriptionRequest(
                        recordingPath = audio.absolutePath,
                        durationMs = (durationSec * 1000.0).roundToInt(),
                        modelId = "paraformer-zh",
                        sampleRateHz = 16_000,
                        enablePunctuation = false,
                        enableDenoise = false,
                    ),
                )
            val elapsed = elapsedMs(started)
            JSONObject()
                .put("status", "ok")
                .put("transcriptionMs", elapsed)
                .put("rtf", elapsed / 1000.0 / durationSec)
                .put("text", result.mergedText)
                .put(
                    "segments",
                    JSONArray(
                        result.segments.map { segment ->
                            JSONObject()
                                .put("sequenceId", segment.sequenceId)
                                .put("startMs", segment.startMs)
                                .put("endMs", segment.endMs)
                        },
                    ),
                )
        } catch (error: Exception) {
            JSONObject()
                .put("status", "error")
                .put("transcriptionMs", elapsedMs(started))
                .put("error", error.message ?: error.javaClass.simpleName)
        }
    }

    private fun deviceState(context: Context): JSONObject {
        val battery = context.getSystemService(BatteryManager::class.java)
        val power = context.getSystemService(PowerManager::class.java)
        return JSONObject()
            .put("elapsedRealtimeMs", SystemClock.elapsedRealtime())
            .put(
                "batteryCapacityPercent",
                battery?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
                    ?: JSONObject.NULL,
            )
            .put(
                "batteryChargeCounterMicroAh",
                battery?.getLongProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER)
                    ?: JSONObject.NULL,
            )
            .put(
                "batteryCurrentNowMicroA",
                battery?.getLongProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)
                    ?: JSONObject.NULL,
            )
            .put(
                "thermalStatus",
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    power?.currentThermalStatus ?: JSONObject.NULL
                } else {
                    JSONObject.NULL
                },
            )
    }

    private fun writePcm16Wav(
        destination: File,
        samples: FloatArray,
        sampleRate: Int,
    ) {
        val dataBytes = samples.size * 2
        DataOutputStream(FileOutputStream(destination)).use { output ->
            output.writeBytes("RIFF")
            output.writeIntLe(36 + dataBytes)
            output.writeBytes("WAVE")
            output.writeBytes("fmt ")
            output.writeIntLe(16)
            output.writeShortLe(1)
            output.writeShortLe(1)
            output.writeIntLe(sampleRate)
            output.writeIntLe(sampleRate * 2)
            output.writeShortLe(2)
            output.writeShortLe(16)
            output.writeBytes("data")
            output.writeIntLe(dataBytes)
            samples.forEach { sample ->
                output.writeShortLe(
                    (sample.coerceIn(-1f, 1f) * Short.MAX_VALUE)
                        .roundToInt()
                        .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()),
                )
            }
        }
    }

    private fun DataOutputStream.writeIntLe(value: Int) {
        writeByte(value)
        writeByte(value ushr 8)
        writeByte(value ushr 16)
        writeByte(value ushr 24)
    }

    private fun DataOutputStream.writeShortLe(value: Int) {
        writeByte(value)
        writeByte(value ushr 8)
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

    private class PeakMemorySampler {
        private val running = AtomicBoolean(true)
        private var peakJava = 0L
        private var peakNative = 0L
        private val thread =
            Thread {
                while (running.get()) {
                    val runtime = Runtime.getRuntime()
                    peakJava = maxOf(peakJava, runtime.totalMemory() - runtime.freeMemory())
                    peakNative = maxOf(peakNative, Debug.getNativeHeapAllocatedSize())
                    SystemClock.sleep(50)
                }
            }

        fun start() {
            thread.start()
        }

        fun stopAndSnapshot(): Pair<Long, Long> {
            running.set(false)
            thread.join(1_000)
            return peakJava to peakNative
        }
    }

    private companion object {
        const val MODEL_BYTES = 535_638L
        const val MODEL_SHA256 = "e77603ac0c23dac3227dd2d7135b3a585cbee2679048aecfa886657d3ae1b534"
        val CASE_IDS =
            listOf(
                "quiet_clean",
                "steady_noise_5db",
                "burst_noise_0db",
                "near_talk",
                "far_talk_5db",
            )
    }
}
