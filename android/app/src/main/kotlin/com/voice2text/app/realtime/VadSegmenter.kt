package com.voice2text.app.realtime

data class VadSegmentDecision(
    val isSpeech: Boolean,
    val started: Boolean,
    val ended: Boolean,
    val startMs: Int,
    val endMs: Int,
)

class VadSegmenter(
    private val speechThreshold: Double = 520.0,
    private val minSpeechMs: Int = 320,
    private val endSilenceMs: Int = 720,
    private val maxSegmentMs: Int = 12000,
) {
    var isInSpeech: Boolean = false
        private set

    private var segmentStartMs = 0
    private var lastSpeechEndMs = 0
    private var trailingSilenceMs = 0

    fun accept(frame: PcmFrame): VadSegmentDecision {
        val speech = PcmAudioNormalizer.rmsPcm16(frame.data) >= speechThreshold
        var started = false
        var ended = false
        var decisionStartMs = segmentStartMs
        var decisionEndMs = frame.endMs

        if (!isInSpeech && speech) {
            isInSpeech = true
            started = true
            segmentStartMs = frame.startMs
            lastSpeechEndMs = frame.endMs
            trailingSilenceMs = 0
            decisionStartMs = segmentStartMs
        } else if (isInSpeech && speech) {
            lastSpeechEndMs = frame.endMs
            trailingSilenceMs = 0
        } else if (isInSpeech) {
            trailingSilenceMs += frame.durationMs
        }

        if (isInSpeech) {
            val segmentDurationMs = frame.endMs - segmentStartMs
            val speechDurationMs = lastSpeechEndMs - segmentStartMs
            if (
                segmentDurationMs >= maxSegmentMs ||
                (trailingSilenceMs >= endSilenceMs && speechDurationMs >= minSpeechMs)
            ) {
                ended = true
                decisionStartMs = segmentStartMs
                decisionEndMs = lastSpeechEndMs.coerceAtLeast(frame.endMs)
                reset()
            } else if (trailingSilenceMs >= endSilenceMs && speechDurationMs < minSpeechMs) {
                reset()
            }
        }

        return VadSegmentDecision(
            isSpeech = speech,
            started = started,
            ended = ended,
            startMs = decisionStartMs,
            endMs = decisionEndMs,
        )
    }

    fun forceEnd(endMs: Int): VadSegmentDecision? {
        if (!isInSpeech) return null
        val start = segmentStartMs
        val end = lastSpeechEndMs.coerceAtLeast(endMs)
        reset()
        return VadSegmentDecision(
            isSpeech = false,
            started = false,
            ended = true,
            startMs = start,
            endMs = end,
        )
    }

    private fun reset() {
        isInSpeech = false
        segmentStartMs = 0
        lastSpeechEndMs = 0
        trailingSilenceMs = 0
    }
}
