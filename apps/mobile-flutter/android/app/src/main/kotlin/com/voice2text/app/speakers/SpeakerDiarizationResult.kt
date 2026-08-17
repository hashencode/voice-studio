package com.voice2text.app.speakers

internal enum class SpeakerSemanticKind {
    ASSIGNED,
    OVERLAP,
    UNKNOWN,
    SILENCE,
}

internal data class SpeakerSemanticInterval(
    val startSample: Long,
    val endSampleExclusive: Long,
    val kind: SpeakerSemanticKind,
    val meetingSpeakerKeys: Set<String> = emptySet(),
    val unknownSpeakerCount: Int = 0,
) {
    init {
        require(startSample >= 0) { "说话人语义区间起点不能为负数" }
        require(endSampleExclusive > startSample) { "说话人语义区间必须具有正长度" }
        require(meetingSpeakerKeys.all(String::isNotBlank)) {
            "会议级说话人 key 不能为空"
        }
        require(unknownSpeakerCount >= 0) { "未知说话人数不能为负数" }
        when (kind) {
            SpeakerSemanticKind.ASSIGNED -> {
                require(meetingSpeakerKeys.size == 1 && unknownSpeakerCount == 0) {
                    "assigned 区间必须且只能包含一个会议级说话人"
                }
            }
            SpeakerSemanticKind.OVERLAP -> {
                require(meetingSpeakerKeys.size + unknownSpeakerCount >= 2) {
                    "overlap 区间必须包含至少两个活动说话人"
                }
            }
            SpeakerSemanticKind.UNKNOWN -> {
                require(meetingSpeakerKeys.isEmpty() && unknownSpeakerCount >= 1) {
                    "unknown 区间必须保留至少一个未归属活动说话人"
                }
            }
            SpeakerSemanticKind.SILENCE -> {
                require(meetingSpeakerKeys.isEmpty() && unknownSpeakerCount == 0) {
                    "silence 区间不能包含说话人"
                }
            }
        }
    }
}

internal data class SpeakerDiarizationResult(
    val sampleRate: Int,
    val totalSamples: Long,
    val intervals: List<SpeakerSemanticInterval>,
) {
    init {
        require(sampleRate > 0) { "说话人结果采样率必须为正数" }
        require(totalSamples > 0) { "说话人结果总样本数必须为正数" }
        require(intervals.isNotEmpty()) { "说话人结果不能为空" }
        require(intervals.first().startSample == 0L) { "说话人结果必须从样本 0 开始" }
        require(intervals.last().endSampleExclusive == totalSamples) {
            "说话人结果必须完整覆盖输入"
        }
        intervals.zipWithNext().forEach { (left, right) ->
            require(left.endSampleExclusive == right.startSample) {
                "说话人结果必须连续、有序且不重叠"
            }
        }
    }
}

internal data class SpeakerSemanticWindowDiagnostics(
    val initializationNanos: Long,
    val diarizationNanos: Long,
    val embeddingNanos: Long,
    val reconciliationNanos: Long,
)

internal data class SpeakerSemanticWindowResult(
    val evidence: SpeakerWindowSemanticEvidence,
    val diagnostics: SpeakerSemanticWindowDiagnostics,
)
