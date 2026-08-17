package com.voice2text.app.transcription

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

@RunWith(AndroidJUnit4::class)
class SpeechEnhancementEvidenceIdentityTest {
    @Test
    fun testCompletePairedReportIsBoundToPinnedModels() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val outputRoot = File(context.filesDir, "device-evidence").apply { mkdirs() }
        val pairedReport = File(outputRoot, "speech-enhancement-paired-gate.json")
        assertTrue("paired report is missing", pairedReport.isFile)
        assertTrue(
            "paired report is incomplete",
            JSONObject(pairedReport.readText()).getBoolean("complete"),
        )

        val recognitionModel = ModelAssetManager(context).ensureParaformerExtracted(MODEL_ID)
        val enhancementModel = ModelAssetManager(context).ensureSpeechEnhancementExtracted()
        assertEquals(RECOGNITION_MODEL_SHA256, sha256(recognitionModel.modelFile))
        assertEquals(RECOGNITION_TOKENS_SHA256, sha256(recognitionModel.tokensFile))
        assertEquals(ENHANCEMENT_MODEL_SHA256, sha256(enhancementModel))

        val identity =
            JSONObject()
                .put("schemaVersion", 1)
                .put("source", "physical_android_instrumentation")
                .put("manufacturer", Build.MANUFACTURER)
                .put("model", Build.MODEL)
                .put("sdkInt", Build.VERSION.SDK_INT)
                .put("pairedReportSha256", sha256(pairedReport))
                .put("recognitionModelId", MODEL_ID)
                .put("recognitionModelSha256", sha256(recognitionModel.modelFile))
                .put("recognitionTokensSha256", sha256(recognitionModel.tokensFile))
                .put("enhancementModelSha256", sha256(enhancementModel))
        File(outputRoot, "speech-enhancement-evidence-identity.json")
            .writeText(identity.toString(2))
    }

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

    private companion object {
        const val MODEL_ID = "paraformer-zh-2025-10-07"
        const val RECOGNITION_MODEL_SHA256 =
            "53813ee1d41722cc6370a571c887e6d0b391d25b8312cf714a31af85ea603812"
        const val RECOGNITION_TOKENS_SHA256 =
            "59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6"
        const val ENHANCEMENT_MODEL_SHA256 =
            "e77603ac0c23dac3227dd2d7135b3a585cbee2679048aecfa886657d3ae1b534"
    }
}
