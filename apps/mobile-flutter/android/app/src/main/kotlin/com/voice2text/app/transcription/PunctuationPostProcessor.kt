package com.voice2text.app.transcription

import com.k2fsa.sherpa.onnx.OfflinePunctuation
import com.k2fsa.sherpa.onnx.OfflinePunctuationConfig
import com.k2fsa.sherpa.onnx.OfflinePunctuationModelConfig
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

internal interface PunctuationBackend {
    fun addPunctuation(text: String): String

    fun release()
}

internal class PunctuationPostProcessor(
    private val backend: PunctuationBackend,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)

    fun process(text: String): String {
        check(!closed.get()) { "标点处理器已释放" }
        val normalized = text.trim()
        if (normalized.isEmpty()) return ""
        val punctuated = backend.addPunctuation(normalized).trim()
        check(punctuated.isNotEmpty()) { "标点模型返回空文本" }
        check(contentCharacters(punctuated) == contentCharacters(normalized)) {
            "标点处理改变了正文内容"
        }
        return punctuated
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) {
            backend.release()
        }
    }

    companion object {
        fun create(
            modelFile: File,
            numThreads: Int,
        ): PunctuationPostProcessor {
            check(modelFile.exists() && modelFile.length() > 0L) {
                "标点模型文件不可用"
            }
            val punctuation = OfflinePunctuation(
                null as android.content.res.AssetManager?,
                OfflinePunctuationConfig(
                    model = OfflinePunctuationModelConfig(
                        ctTransformer = modelFile.absolutePath,
                        numThreads = numThreads,
                        provider = "cpu",
                        debug = false,
                    ),
                ),
            )
            return PunctuationPostProcessor(
                object : PunctuationBackend {
                    override fun addPunctuation(text: String): String =
                        punctuation.addPunctuation(text)

                    override fun release() {
                        punctuation.release()
                    }
                },
            )
        }

        internal fun contentCharacters(text: String): String =
            text.filterNot { character ->
                character.isWhitespace() || character.isPunctuation()
            }

        private fun Char.isPunctuation(): Boolean =
            when (Character.getType(this)) {
                Character.CONNECTOR_PUNCTUATION.toInt(),
                Character.DASH_PUNCTUATION.toInt(),
                Character.START_PUNCTUATION.toInt(),
                Character.END_PUNCTUATION.toInt(),
                Character.INITIAL_QUOTE_PUNCTUATION.toInt(),
                Character.FINAL_QUOTE_PUNCTUATION.toInt(),
                Character.OTHER_PUNCTUATION.toInt(),
                -> true
                else -> false
            }
    }
}
