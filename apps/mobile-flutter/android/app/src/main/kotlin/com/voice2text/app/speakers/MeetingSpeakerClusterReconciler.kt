package com.voice2text.app.speakers

import kotlin.math.sqrt

internal data class WindowSpeakerEvidence(
    val localSpeakerIndex: Int,
    val embedding: FloatArray?,
) {
    init {
        require(localSpeakerIndex >= 0) { "窗口局部说话人索引不能为负数" }
    }
}

internal enum class SpeakerAssignmentKind {
    ASSIGNED,
    UNKNOWN,
}

internal data class MeetingSpeakerAssignment(
    val localSpeakerIndex: Int,
    val kind: SpeakerAssignmentKind,
    val meetingSpeakerKey: String?,
    val createdNewPrototype: Boolean,
)

internal class MeetingSpeakerClusterReconciler(
    private val similarityThreshold: Double,
    private val maximumSpeakerCount: Int = DEFAULT_MAXIMUM_SPEAKER_COUNT,
) : AutoCloseable {
    private data class Prototype(
        val key: String,
        var centroid: FloatArray,
        var observationCount: Int,
    )

    private data class NormalizedEvidence(
        val localSpeakerIndex: Int,
        val embedding: FloatArray,
    )

    private data class MatchEdge(
        val localSpeakerIndex: Int,
        val prototypeKey: String,
        val similarity: Double,
    )

    private val prototypes = linkedMapOf<String, Prototype>()
    private var nextSpeakerNumber = 1
    private var closed = false

    init {
        require(similarityThreshold in -1.0..1.0) {
            "说话人 embedding 相似度阈值必须位于 [-1, 1]"
        }
        require(maximumSpeakerCount > 0) { "会议级说话人上限必须为正数" }
    }

    val activePrototypeCount: Int
        get() = prototypes.size

    fun reconcile(
        evidence: List<WindowSpeakerEvidence>,
    ): List<MeetingSpeakerAssignment> {
        check(!closed) { "会议级说话人 reconciler 已关闭" }
        require(
            evidence.map(WindowSpeakerEvidence::localSpeakerIndex).distinct().size ==
                evidence.size,
        ) {
            "同一窗口不能重复局部说话人索引"
        }
        val normalized = evidence.mapNotNull { item ->
            item.embedding?.let {
                NormalizedEvidence(
                    localSpeakerIndex = item.localSpeakerIndex,
                    embedding = normalize(it),
                )
            }
        }
        val normalizedByIndex = normalized.associateBy { it.localSpeakerIndex }
        val edges = buildEdges(normalized)
        val localsWithAboveThresholdMatch = edges.mapTo(mutableSetOf()) {
            it.localSpeakerIndex
        }
        val matchedByLocal = linkedMapOf<Int, String>()
        val usedPrototypes = mutableSetOf<String>()
        edges.forEach { edge ->
            if (
                edge.localSpeakerIndex !in matchedByLocal &&
                usedPrototypes.add(edge.prototypeKey)
            ) {
                matchedByLocal[edge.localSpeakerIndex] = edge.prototypeKey
            }
        }

        val assignments = mutableListOf<MeetingSpeakerAssignment>()
        evidence.sortedBy(WindowSpeakerEvidence::localSpeakerIndex).forEach { item ->
            val normalizedItem = normalizedByIndex[item.localSpeakerIndex]
            val matchedKey = matchedByLocal[item.localSpeakerIndex]
            when {
                normalizedItem == null -> {
                    assignments += unknownAssignment(item.localSpeakerIndex)
                }
                matchedKey != null -> {
                    updatePrototype(
                        checkNotNull(prototypes[matchedKey]),
                        normalizedItem.embedding,
                    )
                    assignments += assigned(item.localSpeakerIndex, matchedKey, false)
                }
                item.localSpeakerIndex in localsWithAboveThresholdMatch -> {
                    assignments += unknownAssignment(item.localSpeakerIndex)
                }
                prototypes.size >= maximumSpeakerCount -> {
                    assignments += unknownAssignment(item.localSpeakerIndex)
                }
                else -> {
                    val key = "speaker_${nextSpeakerNumber++}"
                    prototypes[key] = Prototype(
                        key = key,
                        centroid = normalizedItem.embedding.copyOf(),
                        observationCount = 1,
                    )
                    assignments += assigned(item.localSpeakerIndex, key, true)
                }
            }
        }
        return assignments
    }

    override fun close() {
        if (closed) return
        prototypes.values.forEach { it.centroid.fill(0.0f) }
        prototypes.clear()
        closed = true
    }

    private fun buildEdges(
        evidence: List<NormalizedEvidence>,
    ): List<MatchEdge> = buildList {
        evidence.forEach { item ->
            prototypes.values.forEach { prototype ->
                val similarity = cosine(item.embedding, prototype.centroid)
                if (similarity >= similarityThreshold) {
                    add(
                        MatchEdge(
                            localSpeakerIndex = item.localSpeakerIndex,
                            prototypeKey = prototype.key,
                            similarity = similarity,
                        ),
                    )
                }
            }
        }
    }.sortedWith(
        compareByDescending<MatchEdge>(MatchEdge::similarity)
            .thenBy(MatchEdge::localSpeakerIndex)
            .thenBy(MatchEdge::prototypeKey),
    )

    private fun updatePrototype(
        prototype: Prototype,
        embedding: FloatArray,
    ) {
        require(prototype.centroid.size == embedding.size) {
            "说话人 embedding 维度发生变化"
        }
        val previousCount = prototype.observationCount
        for (index in prototype.centroid.indices) {
            prototype.centroid[index] =
                (
                    (prototype.centroid[index] * previousCount) +
                        embedding[index]
                    ) / (previousCount + 1)
        }
        val previousCentroid = prototype.centroid
        prototype.centroid = normalize(previousCentroid)
        previousCentroid.fill(0.0f)
        prototype.observationCount += 1
    }

    private fun normalize(embedding: FloatArray): FloatArray {
        require(embedding.isNotEmpty()) { "说话人 embedding 不能为空" }
        require(embedding.all(Float::isFinite)) { "说话人 embedding 包含非有限值" }
        val magnitude = sqrt(embedding.sumOf { value -> value.toDouble() * value })
        require(magnitude > 0.0) { "说话人 embedding 不能为零向量" }
        return FloatArray(embedding.size) { index ->
            (embedding[index] / magnitude).toFloat()
        }
    }

    private fun cosine(
        left: FloatArray,
        right: FloatArray,
    ): Double {
        require(left.size == right.size) { "说话人 embedding 维度不一致" }
        return left.indices.sumOf { index ->
            left[index].toDouble() * right[index]
        }
    }

    private fun assigned(
        localSpeakerIndex: Int,
        key: String,
        createdNewPrototype: Boolean,
    ) = MeetingSpeakerAssignment(
        localSpeakerIndex = localSpeakerIndex,
        kind = SpeakerAssignmentKind.ASSIGNED,
        meetingSpeakerKey = key,
        createdNewPrototype = createdNewPrototype,
    )

    private fun unknownAssignment(localSpeakerIndex: Int) =
        MeetingSpeakerAssignment(
            localSpeakerIndex = localSpeakerIndex,
            kind = SpeakerAssignmentKind.UNKNOWN,
            meetingSpeakerKey = null,
            createdNewPrototype = false,
        )

    private companion object {
        const val DEFAULT_MAXIMUM_SPEAKER_COUNT = 16
    }
}
