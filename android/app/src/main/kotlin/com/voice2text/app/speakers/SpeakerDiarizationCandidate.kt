package com.voice2text.app.speakers

internal data class DiarizationTurn(
    val startSeconds: Double,
    val endSeconds: Double,
    val speakerIndex: Int,
)

internal data class SpeakerDiarizationCandidateResult(
    val candidateId: String,
    val windowStartSample: Long,
    val windowEndSampleExclusive: Long,
    val turns: List<DiarizationTurn>,
    val elapsedNanos: Long,
)

internal abstract class SpeakerDiarizationCandidate(
    val candidateId: String,
    val maximumWindowSamples: Int,
) : AutoCloseable {
    init {
        require(candidateId.isNotBlank()) { "说话人候选 ID 不能为空" }
        require(maximumWindowSamples > 0) { "说话人候选窗口上限必须为正数" }
    }

    fun processWindow(
        window: SpeakerPcmWindow,
        sampleRate: Int = EXPECTED_SAMPLE_RATE,
        numberOfSpeakers: Int = -1,
    ): SpeakerDiarizationCandidateResult {
        require(sampleRate == EXPECTED_SAMPLE_RATE) {
            "说话人候选只接受 16 kHz 单声道 PCM"
        }
        require(window.samples.size <= maximumWindowSamples) {
            "说话人候选输入超过固定窗口上限"
        }
        require(numberOfSpeakers == -1 || numberOfSpeakers > 0) {
            "说话人数必须为正数或 -1（自动聚类）"
        }

        val startedAt = System.nanoTime()
        val turns = diarizeBoundedWindow(window.samples, sampleRate, numberOfSpeakers)
        val elapsedNanos = maxOf(0L, System.nanoTime() - startedAt)
        validateTurns(turns, window.samples.size.toDouble() / sampleRate)
        return SpeakerDiarizationCandidateResult(
            candidateId = candidateId,
            windowStartSample = window.startSample,
            windowEndSampleExclusive = window.endSampleExclusive,
            turns = turns,
            elapsedNanos = elapsedNanos,
        )
    }

    protected abstract fun diarizeBoundedWindow(
        samples: FloatArray,
        sampleRate: Int,
        numberOfSpeakers: Int,
    ): List<DiarizationTurn>

    private fun validateTurns(
        turns: List<DiarizationTurn>,
        windowDurationSeconds: Double,
    ) {
        var previousStart = -1.0
        turns.forEach { turn ->
            require(turn.startSeconds >= previousStart) {
                "说话人候选区间必须按起点排序"
            }
            require(turn.startSeconds >= 0) { "说话人候选区间起点越界" }
            require(turn.endSeconds > turn.startSeconds) {
                "说话人候选区间必须具有正时长"
            }
            require(
                turn.endSeconds <= windowDurationSeconds + BOUNDS_TOLERANCE_SECONDS,
            ) {
                "说话人候选区间终点越界"
            }
            require(turn.speakerIndex >= 0) { "说话人候选索引不能为负数" }
            previousStart = turn.startSeconds
        }
    }

    private companion object {
        const val EXPECTED_SAMPLE_RATE = 16_000
        const val BOUNDS_TOLERANCE_SECONDS = 0.02
    }
}
