package com.voice2text.app.transcription

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TextNormalizationPostProcessorTest {
    @Test
    fun goldenFixtureCoversRequiredTransformsAndPreservesUnsafeInputs() {
        val cases = loadCases()
        val coveredTransforms = cases.filter { it.transformed }.associate { it.input to it.expected }
        val processor = TextNormalizationPostProcessor(ExactMatchBackend(coveredTransforms))

        cases.forEach { case ->
            val result = processor.process(case.input)

            assertEquals(case.id, case.expected, result.text)
            assertEquals(case.id, case.transformed, result.transformed)
        }

        assertEquals(
            setOf("number", "date", "time", "amount", "unit"),
            cases.filter { it.transformed }.mapTo(mutableSetOf()) { it.category },
        )
        assertTrue(
            cases.filterNot { it.transformed }.mapTo(mutableSetOf()) { it.category }.containsAll(
                setOf("ambiguous", "mixed_language", "serial", "phone", "partial"),
            ),
        )
    }

    @Test
    fun normalizationIsIdempotentAndRunsAfterPunctuationWithoutGuessing() {
        val processor = TextNormalizationPostProcessor(
            ExactMatchBackend(
                mapOf(
                    "二零二六年七月二十四日。" to "2026年7月24日。",
                ),
            ),
        )

        val first = processor.process("二零二六年七月二十四日。")
        val second = processor.process(first.text)

        assertEquals("2026年7月24日。", first.text)
        assertTrue(first.transformed)
        assertEquals(first.text, second.text)
        assertFalse(second.transformed)
    }

    @Test
    fun segmentNormalizationChangesOnlyText() {
        val original = listOf(
            TranscriptionSegmentResult(
                sequenceId = 0,
                text = "参会人数二十八人",
                startMs = 120,
                endMs = 980,
                confidence = null,
            ),
            TranscriptionSegmentResult(
                sequenceId = 1,
                text = "型号A一二三B",
                startMs = 1200,
                endMs = 2200,
                confidence = 0.75,
            ),
        )
        val processor = TextNormalizationPostProcessor(
            ExactMatchBackend(mapOf("参会人数二十八人" to "参会人数28人")),
        )

        val normalized = processor.processSegments(original)

        assertEquals(listOf("参会人数28人", "型号A一二三B"), normalized.map { it.text })
        original.zip(normalized).forEach { (before, after) ->
            assertEquals(before.copy(text = after.text), after)
        }
    }

    @Test
    fun nondeterministicOrBlankBackendOutputFailsClosed() {
        var calls = 0
        val nondeterministic = TextNormalizationPostProcessor(
            CompleteMatchItnBackend {
                calls += 1
                if (calls == 1) "2026年7月24日" else "2026-07-24"
            },
        )
        val blank = TextNormalizationPostProcessor(CompleteMatchItnBackend { " " })

        assertThrows(IllegalStateException::class.java) {
            nondeterministic.process("二零二六年七月二十四日")
        }
        assertThrows(IllegalStateException::class.java) {
            blank.process("二零二六年七月二十四日")
        }
    }

    private fun loadCases(): List<FixtureCase> {
        val resource = checkNotNull(javaClass.classLoader?.getResource("itn_golden.json"))
        val root = JSONObject(resource.readText())
        assertEquals(1, root.getInt("schemaVersion"))
        val cases = root.getJSONArray("cases")
        return buildList {
            repeat(cases.length()) { index ->
                val item = cases.getJSONObject(index)
                add(
                    FixtureCase(
                        id = item.getString("id"),
                        category = item.getString("category"),
                        input = item.getString("input"),
                        expected = item.getString("expected"),
                        transformed = item.getBoolean("transformed"),
                    ),
                )
            }
        }
    }

    private data class FixtureCase(
        val id: String,
        val category: String,
        val input: String,
        val expected: String,
        val transformed: Boolean,
    )

    private class ExactMatchBackend(
        private val rules: Map<String, String>,
    ) : CompleteMatchItnBackend {
        override fun normalizeComplete(text: String): String? = rules[text]
    }
}
