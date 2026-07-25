package com.voice2text.app.transcription

/**
 * An ITN backend that may transform only a complete, explicitly covered input.
 *
 * Returning null means the complete input is not covered and must remain unchanged.
 * Implementations must not apply substring guesses or partial regular-expression matches.
 */
fun interface CompleteMatchItnBackend {
    fun normalizeComplete(text: String): String?
}

data class TextNormalizationResult(
    val text: String,
    val transformed: Boolean,
)

class TextNormalizationPostProcessor(
    private val backend: CompleteMatchItnBackend,
) {
    fun process(text: String): TextNormalizationResult {
        val input = text.trim()
        if (input.isEmpty()) {
            return TextNormalizationResult(text = "", transformed = false)
        }

        val first = backend.normalizeComplete(input)
        val repeated = backend.normalizeComplete(input)
        check(first == repeated) {
            "ITN backend returned a non-deterministic result"
        }

        val output = first?.trim() ?: input
        check(output.isNotEmpty()) {
            "ITN backend returned an empty result"
        }
        return TextNormalizationResult(
            text = output,
            transformed = output != input,
        )
    }

    fun processSegments(
        segments: List<TranscriptionSegmentResult>,
    ): List<TranscriptionSegmentResult> =
        segments.map { segment ->
            val result = process(segment.text)
            if (result.transformed) {
                segment.copy(text = result.text)
            } else {
                segment
            }
        }
}
