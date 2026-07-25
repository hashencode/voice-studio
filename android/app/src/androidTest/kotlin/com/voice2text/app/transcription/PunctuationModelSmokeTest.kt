package com.voice2text.app.transcription

import android.os.Debug
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import kotlin.system.measureTimeMillis

@RunWith(AndroidJUnit4::class)
class PunctuationModelSmokeTest {
    @Test
    fun testKnownTextAndRepositoryWavUseRealModel() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val assets = ModelAssetManager(context)
        val punctuationModel = assets.ensurePunctuationExtracted()
        assertTrue(punctuationModel.isFile)
        assertTrue(punctuationModel.length() > 0L)

        val knownInput = "今天下午三点开会讨论项目进度谢谢大家"
        var knownOutput = ""
        val knownCostMs =
            measureTimeMillis {
                PunctuationPostProcessor.create(
                    modelFile = punctuationModel,
                    numThreads = 1,
                ).use { processor ->
                    knownOutput = processor.process(knownInput)
                }
            }
        assertEquals(
            PunctuationPostProcessor.contentCharacters(knownInput),
            PunctuationPostProcessor.contentCharacters(knownOutput),
        )
        assertTrue("real model should add punctuation", knownOutput != knownInput)

        val wav = File(context.cacheDir, "punctuation-smoke-test.wav")
        context.assets.open("flutter_assets/assets/sherpa/wav/test.wav").use { input ->
            wav.outputStream().use(input::copyTo)
        }
        val engine = RealSherpaTranscriptionEngine(context)
        lateinit var raw: TranscriptionResult
        lateinit var punctuated: TranscriptionResult
        val rawCostMs =
            measureTimeMillis {
                raw =
                    engine.transcribe(
                        request(wav, enablePunctuation = false),
                    )
            }
        val punctuatedCostMs =
            measureTimeMillis {
                punctuated =
                    engine.transcribe(
                        request(wav, enablePunctuation = true),
                    )
            }
        assertEquals(raw.segments.size, punctuated.segments.size)
        assertTrue(
            "current Paraformer production result must keep confidence unknown",
            raw.segments.all { it.confidence == null } &&
                punctuated.segments.all { it.confidence == null },
        )
        raw.segments.zip(punctuated.segments).forEach { (before, after) ->
            assertEquals(before.sequenceId, after.sequenceId)
            assertEquals(before.startMs, after.startMs)
            assertEquals(before.endMs, after.endMs)
            assertEquals(
                PunctuationPostProcessor.contentCharacters(before.text),
                PunctuationPostProcessor.contentCharacters(after.text),
            )
        }
        assertTrue(
            "repository WAV should gain punctuation",
            raw.segments.zip(punctuated.segments).any { (before, after) ->
                before.text != after.text
            },
        )

        val runtime = Runtime.getRuntime()
        val javaHeapBytes = runtime.totalMemory() - runtime.freeMemory()
        val nativeHeapBytes = Debug.getNativeHeapAllocatedSize()
        Log.i(
            TAG,
            "punctuation smoke ok " +
                "modelBytes=${punctuationModel.length()} " +
                "knownCostMs=$knownCostMs rawCostMs=$rawCostMs " +
                "punctuatedCostMs=$punctuatedCostMs " +
                "segments=${raw.segments.size} " +
                "contentSha256=${sha256(PunctuationPostProcessor.contentCharacters(punctuated.mergedText))} " +
                "javaHeapBytes=$javaHeapBytes nativeHeapBytes=$nativeHeapBytes",
        )
        wav.delete()
    }

    private fun request(
        wav: File,
        enablePunctuation: Boolean,
    ): TranscriptionRequest =
        TranscriptionRequest(
            recordingPath = wav.absolutePath,
            durationMs = 272_399,
            modelId = "paraformer-zh",
            sampleRateHz = 16_000,
            enablePunctuation = enablePunctuation,
            enableDenoise = false,
        )

    private fun sha256(value: String): String =
        MessageDigest
            .getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    private companion object {
        const val TAG = "Voice2TextDeviceTest"
    }
}
