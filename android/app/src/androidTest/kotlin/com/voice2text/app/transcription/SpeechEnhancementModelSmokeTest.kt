package com.voice2text.app.transcription

import android.os.Debug
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import kotlin.math.sqrt
import kotlin.random.Random
import kotlin.system.measureTimeMillis

@RunWith(AndroidJUnit4::class)
class SpeechEnhancementModelSmokeTest {
    @Test
    fun officialGtcrnRunsOnDeterministicNoisySpeech() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val model = ModelAssetManager(context).ensureSpeechEnhancementExtracted()
        assertEquals(535_638L, model.length())

        val wav = File(context.cacheDir, "enhancement-smoke-source.wav")
        context.assets.open("flutter_assets/assets/sherpa/wav/test.wav").use { input ->
            wav.outputStream().use(input::copyTo)
        }
        var fiveSeconds: FloatArray? = null
        WavPcmChunkReader(wav).readChunks(maxSamplesPerChunk = 80_000) { _, samples ->
            if (fiveSeconds == null) {
                fiveSeconds = samples.copyOf()
            }
        }
        val clean = checkNotNull(fiveSeconds)
        val random = Random(20_260_724)
        val noisy = FloatArray(clean.size) { index ->
            (clean[index] + ((random.nextFloat() * 2f - 1f) * 0.08f))
                .coerceIn(-1f, 1f)
        }

        lateinit var enhanced: EnhancedSpeech
        val costMs =
            measureTimeMillis {
                SpeechEnhancementProcessor.create(model, numThreads = 1).use { processor ->
                    enhanced = processor.process(noisy, 16_000)
                }
            }

        assertEquals(16_000, enhanced.sampleRate)
        assertTrue(enhanced.samples.isNotEmpty())
        assertTrue(enhanced.samples.all(Float::isFinite))
        assertNotEquals(sha256(noisy), sha256(enhanced.samples))
        assertTrue(rms(enhanced.samples) > 0.0001)

        val runtime = Runtime.getRuntime()
        Log.i(
            TAG,
            "enhancement smoke ok modelBytes=${model.length()} " +
                "inputSamples=${noisy.size} outputSamples=${enhanced.samples.size} " +
                "costMs=$costMs rtf=${costMs / 5000.0} " +
                "inputSha256=${sha256(noisy)} outputSha256=${sha256(enhanced.samples)} " +
                "javaHeapBytes=${runtime.totalMemory() - runtime.freeMemory()} " +
                "nativeHeapBytes=${Debug.getNativeHeapAllocatedSize()}",
        )
        wav.delete()
    }

    private fun rms(samples: FloatArray): Double =
        sqrt(samples.sumOf { it.toDouble() * it.toDouble() } / samples.size)

    private fun sha256(samples: FloatArray): String {
        val bytes = ByteBuffer
            .allocate(samples.size * Float.SIZE_BYTES)
            .order(ByteOrder.LITTLE_ENDIAN)
        samples.forEach(bytes::putFloat)
        return MessageDigest
            .getInstance("SHA-256")
            .digest(bytes.array())
            .joinToString("") { "%02x".format(it) }
    }

    private companion object {
        const val TAG = "Voice2TextDeviceTest"
    }
}
