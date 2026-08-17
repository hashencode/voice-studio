package com.voice2text.app.speakers

import kotlin.math.min

internal data class SpeakerWindowActivity(
    val startSample: Long,
    val endSampleExclusive: Long,
    val meetingSpeakerKey: String?,
) {
    init {
        require(startSample >= 0) { "窗口活动起点不能为负数" }
        require(endSampleExclusive > startSample) { "窗口活动必须具有正长度" }
        require(meetingSpeakerKey == null || meetingSpeakerKey.isNotBlank()) {
            "会议级说话人 key 不能为空"
        }
    }
}

internal data class SpeakerWindowSemanticEvidence(
    val windowStartSample: Long,
    val windowEndSampleExclusive: Long,
    val activities: List<SpeakerWindowActivity>,
) {
    init {
        require(windowStartSample >= 0) { "窗口起点不能为负数" }
        require(windowEndSampleExclusive > windowStartSample) {
            "窗口必须具有正长度"
        }
        activities.forEach { activity ->
            require(
                activity.startSample >= windowStartSample &&
                    activity.endSampleExclusive <= windowEndSampleExclusive,
            ) {
                "说话人活动越过所属窗口"
            }
        }
    }
}

internal class SpeakerTurnStitcher {
    fun stitch(
        windows: List<SpeakerWindowSemanticEvidence>,
        totalSamples: Long,
        sampleRate: Int,
    ): SpeakerDiarizationResult {
        require(windows.isNotEmpty()) { "说话人窗口证据不能为空" }
        require(totalSamples > 0) { "总样本数必须为正数" }
        require(sampleRate > 0) { "采样率必须为正数" }
        val orderedWindows = windows.sortedBy(SpeakerWindowSemanticEvidence::windowStartSample)
        require(orderedWindows.first().windowStartSample == 0L) {
            "说话人窗口必须从样本 0 开始"
        }
        require(orderedWindows.last().windowEndSampleExclusive == totalSamples) {
            "说话人窗口必须覆盖输入尾部"
        }
        orderedWindows.zipWithNext().forEach { (left, right) ->
            require(right.windowStartSample <= left.windowEndSampleExclusive) {
                "说话人窗口之间不能有空洞"
            }
        }

        val boundaries = sortedSetOf(0L, totalSamples)
        orderedWindows.forEach { window ->
            require(window.windowEndSampleExclusive <= totalSamples) {
                "说话人窗口越过输入尾部"
            }
            boundaries += window.windowStartSample
            boundaries += window.windowEndSampleExclusive
            window.activities.forEach { activity ->
                boundaries += activity.startSample
                boundaries += activity.endSampleExclusive
            }
        }

        val intervals = mutableListOf<SpeakerSemanticInterval>()
        boundaries.toList().zipWithNext().forEach { (start, end) ->
            if (end == start) return@forEach
            val owner = selectOwner(orderedWindows, start, end)
            val active = owner.activities.filter { activity ->
                activity.startSample <= start &&
                    activity.endSampleExclusive >= end
            }
            appendOrMerge(intervals, semanticInterval(start, end, active))
        }
        return SpeakerDiarizationResult(
            sampleRate = sampleRate,
            totalSamples = totalSamples,
            intervals = intervals,
        )
    }

    private fun selectOwner(
        windows: List<SpeakerWindowSemanticEvidence>,
        start: Long,
        end: Long,
    ): SpeakerWindowSemanticEvidence {
        val candidates = windows.filter { window ->
            window.windowStartSample <= start &&
                window.windowEndSampleExclusive >= end
        }
        check(candidates.isNotEmpty()) { "没有窗口覆盖语义区间" }
        val midpoint = start + ((end - start) / 2.0)
        return candidates.maxWith(
            compareBy<SpeakerWindowSemanticEvidence> { window ->
                min(
                    midpoint - window.windowStartSample,
                    window.windowEndSampleExclusive - midpoint,
                )
            }.thenBy { window -> -window.windowStartSample },
        )
    }

    private fun semanticInterval(
        start: Long,
        end: Long,
        active: List<SpeakerWindowActivity>,
    ): SpeakerSemanticInterval {
        if (active.isEmpty()) {
            return SpeakerSemanticInterval(start, end, SpeakerSemanticKind.SILENCE)
        }
        val assignedKeys = active.mapNotNull(SpeakerWindowActivity::meetingSpeakerKey).toSet()
        val unknownCount = active.count { it.meetingSpeakerKey == null }
        val activeSpeakerCount = assignedKeys.size + unknownCount
        return when {
            activeSpeakerCount >= 2 -> {
                SpeakerSemanticInterval(
                    startSample = start,
                    endSampleExclusive = end,
                    kind = SpeakerSemanticKind.OVERLAP,
                    meetingSpeakerKeys = assignedKeys,
                    unknownSpeakerCount = unknownCount,
                )
            }
            assignedKeys.size == 1 -> {
                SpeakerSemanticInterval(
                    startSample = start,
                    endSampleExclusive = end,
                    kind = SpeakerSemanticKind.ASSIGNED,
                    meetingSpeakerKeys = assignedKeys,
                )
            }
            else -> {
                SpeakerSemanticInterval(
                    startSample = start,
                    endSampleExclusive = end,
                    kind = SpeakerSemanticKind.UNKNOWN,
                    unknownSpeakerCount = maxOf(1, unknownCount),
                )
            }
        }
    }

    private fun appendOrMerge(
        intervals: MutableList<SpeakerSemanticInterval>,
        next: SpeakerSemanticInterval,
    ) {
        val previous = intervals.lastOrNull()
        if (
            previous != null &&
            previous.endSampleExclusive == next.startSample &&
            previous.kind == next.kind &&
            previous.meetingSpeakerKeys == next.meetingSpeakerKeys &&
            previous.unknownSpeakerCount == next.unknownSpeakerCount
        ) {
            intervals[intervals.lastIndex] =
                previous.copy(endSampleExclusive = next.endSampleExclusive)
        } else {
            intervals += next
        }
    }
}
