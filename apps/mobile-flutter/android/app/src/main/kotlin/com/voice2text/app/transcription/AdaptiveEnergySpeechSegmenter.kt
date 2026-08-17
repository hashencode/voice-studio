package com.voice2text.app.transcription

import kotlin.math.ceil
import kotlin.math.sqrt

internal data class SpeechSampleRange(
    val startOffset: Int,
    val endOffsetExclusive: Int,
) {
    init {
        require(startOffset >= 0)
        require(endOffsetExclusive > startOffset)
    }

    val sampleCount: Int
        get() = endOffsetExclusive - startOffset
}

/**
 * Splits an over-broad VAD speech region only at sustained low-energy gaps.
 *
 * Silero remains the outer speech detector. This second stage uses the region's
 * own 10th/90th percentile RMS range so the threshold follows recording gain
 * instead of fitting a fixed amplitude or a fixture-specific timestamp.
 */
internal class AdaptiveEnergySpeechSegmenter(
    private val frameDurationMs: Int = 20,
    private val minSilenceDurationMs: Int = 400,
    private val minSpeechDurationMs: Int = 250,
    private val endPaddingMs: Int = 20,
    private val dynamicRangeFraction: Double = 0.20,
) {
    init {
        require(frameDurationMs > 0)
        require(minSilenceDurationMs >= frameDurationMs)
        require(minSpeechDurationMs > 0)
        require(endPaddingMs >= 0)
        require(dynamicRangeFraction in 0.0..1.0)
    }

    fun split(
        samples: FloatArray,
        sampleRate: Int,
    ): List<SpeechSampleRange> {
        require(sampleRate > 0)
        if (samples.isEmpty()) return emptyList()

        val frameSize =
            ((sampleRate.toLong() * frameDurationMs) / 1000L)
                .toInt()
                .coerceAtLeast(1)
        val frameCount = ceil(samples.size.toDouble() / frameSize).toInt()
        val rmsValues = DoubleArray(frameCount)
        for (frameIndex in 0 until frameCount) {
            val start = frameIndex * frameSize
            val end = (start + frameSize).coerceAtMost(samples.size)
            var sumSquares = 0.0
            for (sampleIndex in start until end) {
                val sample = samples[sampleIndex].toDouble()
                sumSquares += sample * sample
            }
            rmsValues[frameIndex] = sqrt(sumSquares / (end - start))
        }
        val sorted = rmsValues.copyOf().apply { sort() }
        val noiseFloor = percentile(sorted, 0.10)
        val speechLevel = percentile(sorted, 0.90)
        val threshold = noiseFloor + ((speechLevel - noiseFloor) * dynamicRangeFraction)
        val silenceFrames =
            ceil(minSilenceDurationMs.toDouble() / frameDurationMs).toInt()
        val speechFrames =
            ceil(minSpeechDurationMs.toDouble() / frameDurationMs).toInt()
        val paddingFrames =
            ceil(endPaddingMs.toDouble() / frameDurationMs).toInt()

        val ranges = mutableListOf<SpeechSampleRange>()
        var startFrame: Int? = null
        var lastActiveFrame: Int? = null
        var currentSilenceFrames = 0

        fun finishRange() {
            val start = startFrame ?: return
            val last = lastActiveFrame ?: return
            val endFrameExclusive =
                (last + 1 + paddingFrames).coerceAtMost(rmsValues.size)
            if (endFrameExclusive - start >= speechFrames) {
                ranges.add(
                    SpeechSampleRange(
                        startOffset = start * frameSize,
                        endOffsetExclusive =
                            (endFrameExclusive * frameSize).coerceAtMost(samples.size),
                    ),
                )
            }
            startFrame = null
            lastActiveFrame = null
            currentSilenceFrames = 0
        }

        rmsValues.forEachIndexed { index, rms ->
            if (rms >= threshold) {
                if (startFrame == null) startFrame = index
                lastActiveFrame = index
                currentSilenceFrames = 0
            } else if (startFrame != null) {
                currentSilenceFrames += 1
                if (currentSilenceFrames >= silenceFrames) finishRange()
            }
        }
        finishRange()

        return ranges.ifEmpty {
            listOf(SpeechSampleRange(startOffset = 0, endOffsetExclusive = samples.size))
        }
    }

    private fun percentile(
        sorted: DoubleArray,
        percentile: Double,
    ): Double {
        val index = ((sorted.size - 1) * percentile).toInt()
        return sorted[index.coerceIn(0, sorted.lastIndex)]
    }
}
