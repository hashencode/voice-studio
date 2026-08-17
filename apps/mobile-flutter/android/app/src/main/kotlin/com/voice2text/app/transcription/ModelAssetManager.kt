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

    @Synchronized
    fun ensurePunctuationExtracted(): File {
        val punctuationFile = File(
            context.cacheDir,
            "sherpa_models/punctuation-ct-transformer.onnx",
        )
        if (punctuationFile.exists() && punctuationFile.length() > 0L) {
            return punctuationFile
        }

        punctuationFile.parentFile?.mkdirs()
        val partial = File("${punctuationFile.absolutePath}.partial")
        try {
            if (partial.exists()) {
                partial.delete()
            }
            context.assets.open(PUNCTUATION_ASSET_PATH).use { raw ->
                FileOutputStream(partial).use { out ->
                    raw.copyTo(out)
                    out.fd.sync()
                }
            }
            if (partial.length() == 0L) {
                throw IllegalStateException("标点模型提取失败")
            }
            if (punctuationFile.exists() && !punctuationFile.delete()) {
                throw IllegalStateException("无法替换损坏的标点模型")
            }
            if (!partial.renameTo(punctuationFile)) {
                throw IllegalStateException("标点模型提取失败")
            }
            return punctuationFile
        } catch (error: Exception) {
            partial.delete()
            throw error
        }
    }

    @Synchronized
    fun ensureSpeechEnhancementExtracted(): File {
        val enhancementFile = File(
            context.cacheDir,
            "sherpa_models/gtcrn-simple.onnx",
        )
        if (enhancementFile.isFile && enhancementFile.length() > 0L) {
            return enhancementFile
        }

        enhancementFile.parentFile?.mkdirs()
        val partial = File("${enhancementFile.absolutePath}.partial")
        try {
            if (partial.exists()) {
                partial.delete()
            }
            context.assets.open(SPEECH_ENHANCEMENT_ASSET_PATH).use { raw ->
                FileOutputStream(partial).use { out ->
                    raw.copyTo(out)
                    out.fd.sync()
                }
            }
            if (partial.length() == 0L) {
                throw IllegalStateException("语音增强模型提取失败")
            }
            if (enhancementFile.exists() && !enhancementFile.delete()) {
                throw IllegalStateException("无法替换损坏的语音增强模型")
            }
            if (!partial.renameTo(enhancementFile)) {
                throw IllegalStateException("语音增强模型提取失败")
            }
            return enhancementFile
        } catch (error: Exception) {
            partial.delete()
            throw error
        }
    }

    companion object {
        const val VAD_ASSET_PATH = "flutter_assets/assets/sherpa/onnx/silero-vad.onnx"
        const val PUNCTUATION_ASSET_PATH =
            "flutter_assets/assets/sherpa/onnx/punctuation.onnx"
        const val SPEECH_ENHANCEMENT_ASSET_PATH =
            "flutter_assets/assets/sherpa/onnx/speech-enhancement.onnx"
    }
}
