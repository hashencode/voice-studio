package com.voice2text.app.transcription

import android.content.Context
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

data class ExtractedParaformerModel(
    val modelFile: File,
    val tokensFile: File,
)

class ModelAssetManager(
    private val context: Context,
) {
    fun descriptorFor(modelId: String): TranscriptionModelDescriptor {
        return TranscriptionModelRegistry.descriptorFor(modelId)
    }

    fun requiredAssetsFor(modelId: String): List<String> {
        val descriptor = descriptorFor(modelId)
        if (descriptor.assetPath.isBlank()) {
            return emptyList()
        }
        return listOf(descriptor.assetPath)
    }

    fun assetExists(path: String): Boolean {
        if (path.isBlank()) return false
        return try {
            context.assets.open(path).use { true }
        } catch (_: Exception) {
            false
        }
    }

    fun ensureParaformerExtracted(modelId: String): ExtractedParaformerModel {
        val descriptor = descriptorFor(modelId)
        if (descriptor.assetPath.isBlank()) {
            throw IllegalStateException("模型资源未配置: ${descriptor.id}")
        }

        val modelDir = File(context.cacheDir, "sherpa_models/paraformer_zh")
        val modelFile = File(modelDir, "model.int8.onnx")
        val tokensFile = File(modelDir, "tokens.txt")
        if (
            modelFile.exists() &&
            tokensFile.exists() &&
            modelFile.length() > 0L &&
            tokensFile.length() > 0L
        ) {
            return ExtractedParaformerModel(modelFile, tokensFile)
        }

        if (!modelDir.exists()) modelDir.mkdirs()
        context.assets.open(descriptor.assetPath).use { raw ->
            ZipInputStream(BufferedInputStream(raw)).use { zis ->
                var entry = zis.nextEntry
                while (entry != null) {
                    if (!entry.isDirectory) {
                        val out = File(modelDir, entry.name.substringAfterLast('/'))
                        FileOutputStream(out).use { fos ->
                            zis.copyTo(fos)
                        }
                    }
                    zis.closeEntry()
                    entry = zis.nextEntry
                }
            }
        }
        return ExtractedParaformerModel(modelFile, tokensFile)
    }

    fun ensureVadExtracted(): File {
        val vadFile = File(context.cacheDir, "sherpa_models/silero-vad.onnx")
        if (vadFile.exists() && vadFile.length() > 0L) {
            return vadFile
        }

        vadFile.parentFile?.mkdirs()
        context.assets.open(VAD_ASSET_PATH).use { raw ->
            FileOutputStream(vadFile).use { out ->
                raw.copyTo(out)
            }
        }
        return vadFile
    }

    companion object {
        const val VAD_ASSET_PATH = "flutter_assets/assets/sherpa/onnx/silero-vad.onnx"
    }
}
