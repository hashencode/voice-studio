package com.voice2text.app.transcription

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PunctuationPostProcessorTest {
    @Test
    fun `process keeps content characters and accepts punctuation changes`() {
        val backend = FakeBackend { "我们开会，讨论方案。" }
        val processor = PunctuationPostProcessor(backend)

        assertEquals("我们开会，讨论方案。", processor.process("我们开会讨论方案"))
        assertEquals(
            "我们开会讨论方案",
            PunctuationPostProcessor.contentCharacters("我们开会，讨论方案。"),
        )
    }

    @Test
    fun `blank input does not invoke the model`() {
        val backend = FakeBackend { error("should not run") }
        val processor = PunctuationPostProcessor(backend)

        assertEquals("", processor.process("  "))
        assertEquals(0, backend.calls)
    }

    @Test
    fun `changed content and empty model output fail closed`() {
        val changed = PunctuationPostProcessor(FakeBackend { "另一个句子。" })
        val empty = PunctuationPostProcessor(FakeBackend { "" })

        assertThrows(IllegalStateException::class.java) {
            changed.process("原始句子")
        }
        assertThrows(IllegalStateException::class.java) {
            empty.process("原始句子")
        }
    }

    @Test
    fun `close releases exactly once and prevents future use`() {
        val backend = FakeBackend { "$it。" }
        val processor = PunctuationPostProcessor(backend)

        processor.close()
        processor.close()

        assertEquals(1, backend.releases)
        assertThrows(IllegalStateException::class.java) {
            processor.process("已经关闭")
        }
    }

    @Test
    fun `content invariant ignores unicode whitespace and punctuation only`() {
        val normalized = PunctuationPostProcessor.contentCharacters(
            "Hello，世界！\n“测试” —— OK。",
        )

        assertEquals("Hello世界测试OK", normalized)
        assertTrue(normalized.isNotEmpty())
    }

    private class FakeBackend(
        private val transform: (String) -> String,
    ) : PunctuationBackend {
        var calls = 0
        var releases = 0

        override fun addPunctuation(text: String): String {
            calls += 1
            return transform(text)
        }

        override fun release() {
            releases += 1
        }
    }
}
