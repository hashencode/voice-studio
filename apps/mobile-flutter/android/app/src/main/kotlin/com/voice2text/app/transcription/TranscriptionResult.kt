package com.voice2text.app.transcription

data class TranscriptionSegmentResult(
    val sequenceId: Int,
    val text: String,
    val startMs: Long,
    val endMs: Long,
    val isFinal: Boolean = true,
    val source: String = "standard_offline",
    val confidence: Double? = null,
) {
    fun toMap(): Map<String, Any?> =
        mapOf(
            "sequenceId" to sequenceId,
            "text" to text,
            "startMs" to startMs,
            "endMs" to endMs,
            "isFinal" to isFinal,
            "source" to source,
            "confidence" to confidence,
        )
}

data class TranscriptionResult(
    val mergedText: String,
    val segments: List<TranscriptionSegmentResult>,
) {
    init {
        require(segments.isNotEmpty()) { "转写结果不包含可持久化片段" }
        var previousEndMs = 0L
        segments.forEachIndexed { index, segment ->
            require(segment.sequenceId == index) { "转写片段序号不连续" }
            require(segment.text.isNotBlank()) { "转写片段文本为空" }
            require(segment.startMs >= previousEndMs) { "转写片段时间范围重叠" }
            require(segment.endMs > segment.startMs) { "转写片段时间范围无效" }
            require(segment.isFinal) { "生产转写结果只能包含最终片段" }
            require(segment.source.isNotBlank()) { "转写片段来源为空" }
            require(segment.confidence == null || segment.confidence in 0.0..1.0) {
                "转写片段置信度无效"
            }
            previousEndMs = segment.endMs
        }
        require(mergedText.trim() == segments.joinToString(" ") { it.text.trim() }) {
            "合并文本与片段顺序不一致"
        }
    }

    fun toMap(): Map<String, Any?> =
        mapOf(
            "mergedText" to mergedText.trim(),
            "segments" to segments.map(TranscriptionSegmentResult::toMap),
        )

    companion object {
        fun fromSegments(segments: List<TranscriptionSegmentResult>): TranscriptionResult =
            TranscriptionResult(
                mergedText = segments.joinToString(" ") { it.text.trim() },
                segments = segments,
            )

        fun singleText(
            text: String,
            durationMs: Int,
        ): TranscriptionResult {
            val normalized = text.trim()
            return fromSegments(
                listOf(
                    TranscriptionSegmentResult(
                        sequenceId = 0,
                        text = normalized,
                        startMs = 0,
                        endMs = durationMs.coerceAtLeast(1).toLong(),
                    ),
                ),
            )
        }
    }
}

internal class VadTimestampMapper(
    private val sampleRate: Int,
) {
    private var previousEndMs = 0L

    init {
        require(sampleRate > 0)
    }

    fun map(
        sequenceId: Int,
        text: String,
        startSample: Long,
        sampleCount: Int,
        confidence: Double? = null,
    ): TranscriptionSegmentResult {
        require(startSample >= 0)
        require(sampleCount > 0)
        val rawStartMs = samplesToMs(startSample)
        val rawEndMs = samplesToMs(startSample + sampleCount)
        val startMs = maxOf(rawStartMs, previousEndMs)
        val endMs = maxOf(rawEndMs, startMs + 1)
        previousEndMs = endMs
        return TranscriptionSegmentResult(
            sequenceId = sequenceId,
            text = text.trim(),
            startMs = startMs,
            endMs = endMs,
            confidence = confidence,
        )
    }

    private fun samplesToMs(samples: Long): Long = (samples * 1000L) / sampleRate
}
