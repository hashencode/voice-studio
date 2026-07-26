package com.voice2text.app.speakers

import android.content.Context
import com.k2fsa.sherpa.onnx.FastClusteringConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarization
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarizationConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerSegmentationModelConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerSegmentationPyannoteModelConfig
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import kotlin.math.ceil

internal class SpeakerDiarizationUnavailableException(
    val decision: SpeakerDiarizationGateDecision,
) : IllegalStateException(decision.reason)

/**
 * Thin wrapper around the API pinned from the installed v1.13.3 AAR.
 *
 * This deliberately accepts PCM samples independently from the Paraformer
 * request/result contract. Callers must not instantiate it while the registry is
 * deferred, and no embedding is ever returned or persisted.
 */
internal class SherpaSpeakerDiarizationEngine(
    private val context: Context,
    private val registry: SpeakerDiarizationModelRegistry =
        SpeakerDiarizationModelRegistry(context),
    candidateId: String = CURRENT_CANDIDATE_ID,
) : SpeakerDiarizationCandidate(
        candidateId = candidateId,
        maximumWindowSamples = MAXIMUM_WINDOW_SAMPLES,
    ) {
    private var diarizer: OfflineSpeakerDiarization? = null
    private var configuredNumberOfSpeakers: Int? = null
    private var lastInitializationNanos = 0L
    private var closed = false

    private fun processSamples(
        samples: FloatArray,
        expectedSampleRate: Int = 16_000,
        numberOfSpeakers: Int = -1,
        admissionProbe: Boolean = false,
    ): List<DiarizationTurn> {
        check(!closed) { "说话人 diarization engine 已关闭" }
        val decision =
            if (admissionProbe) {
                registry.evaluateCandidateArtifacts()
            } else {
                registry.evaluate()
            }
        if (!decision.isAvailable) {
            throw SpeakerDiarizationUnavailableException(decision)
        }
        require(samples.isNotEmpty()) { "音频样本不能为空" }
        require(expectedSampleRate == 16_000) { "说话人模型只接受 16 kHz 单声道 PCM" }
        require(numberOfSpeakers == -1 || numberOfSpeakers > 0) {
            "说话人数必须为正数或 -1（自动聚类）"
        }

        if (configuredNumberOfSpeakers != numberOfSpeakers) {
            diarizer?.release()
            diarizer = null
        }
        lastInitializationNanos = 0L
        val engine = diarizer ?: run {
            val initializationStarted = System.nanoTime()
            createDiarizer(numberOfSpeakers).also {
                lastInitializationNanos =
                    maxOf(0L, System.nanoTime() - initializationStarted)
                diarizer = it
                configuredNumberOfSpeakers = numberOfSpeakers
            }
        }
        check(engine.sampleRate() == expectedSampleRate) {
            "Sherpa diarization 采样率与输入不一致"
        }
        val durationSeconds = samples.size.toDouble() / expectedSampleRate
        return engine.process(samples)
            .map {
                DiarizationTurn(
                    startSeconds = it.start.toDouble(),
                    endSeconds = it.end.toDouble(),
                    speakerIndex = it.speaker,
                )
            }
            .sortedWith(compareBy(DiarizationTurn::startSeconds, DiarizationTurn::endSeconds))
            .also { validateBounds(it, durationSeconds) }
    }

    override fun close() {
        if (closed) return
        diarizer?.release()
        diarizer = null
        configuredNumberOfSpeakers = null
        closed = true
    }

    fun processSemanticWindow(
        window: SpeakerPcmWindow,
        embeddingExtractor: SherpaSpeakerEmbeddingExtractor,
        reconciler: MeetingSpeakerClusterReconciler,
        sampleRate: Int = 16_000,
        numberOfSpeakers: Int = -1,
    ): SpeakerSemanticWindowResult {
        val localResult = processWindow(window, sampleRate, numberOfSpeakers)
        var embeddingNanos = 0L
        val evidenceByLocal =
            localResult.turns
                .map(DiarizationTurn::speakerIndex)
                .distinct()
                .sorted()
                .map { localSpeakerIndex ->
                    val embeddingSamples =
                        selectEmbeddingSamples(
                            samples = window.samples,
                            turns = localResult.turns,
                            localSpeakerIndex = localSpeakerIndex,
                            sampleRate = sampleRate,
                        )
                    val embedding =
                        embeddingSamples?.let {
                            val started = System.nanoTime()
                            try {
                                embeddingExtractor.extract(it, sampleRate)
                            } finally {
                                embeddingNanos += maxOf(0L, System.nanoTime() - started)
                            }
                        }
                    WindowSpeakerEvidence(
                        localSpeakerIndex = localSpeakerIndex,
                        embedding = embedding,
                    )
                }
        val reconciliationStarted = System.nanoTime()
        val assignments =
            reconciler.reconcile(evidenceByLocal)
        val reconciliationNanos =
            maxOf(0L, System.nanoTime() - reconciliationStarted)
        val assignmentByLocal = assignments.associateBy(
            MeetingSpeakerAssignment::localSpeakerIndex,
        )
        return SpeakerSemanticWindowResult(
            evidence =
                SpeakerWindowSemanticEvidence(
                    windowStartSample = window.startSample,
                    windowEndSampleExclusive = window.endSampleExclusive,
                    activities =
                        localResult.turns.map { turn ->
                            val startOffset =
                                (turn.startSeconds * sampleRate).toLong()
                                    .coerceIn(0, (window.samples.size - 1).toLong())
                            val endOffset =
                                ceil(turn.endSeconds * sampleRate).toLong()
                                    .coerceIn(startOffset + 1, window.samples.size.toLong())
                            SpeakerWindowActivity(
                                startSample = window.startSample + startOffset,
                                endSampleExclusive = window.startSample + endOffset,
                                meetingSpeakerKey =
                                    assignmentByLocal[turn.speakerIndex]?.meetingSpeakerKey,
                            )
                        },
                ),
            diagnostics =
                SpeakerSemanticWindowDiagnostics(
                    initializationNanos = lastInitializationNanos,
                    diarizationNanos =
                        maxOf(0L, localResult.elapsedNanos - lastInitializationNanos),
                    embeddingNanos = embeddingNanos,
                    reconciliationNanos = reconciliationNanos,
                ),
        )
    }

    override fun diarizeBoundedWindow(
        samples: FloatArray,
        sampleRate: Int,
        numberOfSpeakers: Int,
    ): List<DiarizationTurn> = processSamples(
        samples = samples,
        expectedSampleRate = sampleRate,
        numberOfSpeakers = numberOfSpeakers,
        admissionProbe = true,
    )

    private fun selectEmbeddingSamples(
        samples: FloatArray,
        turns: List<DiarizationTurn>,
        localSpeakerIndex: Int,
        sampleRate: Int,
    ): FloatArray? {
        val targetRanges =
            turns.filter { it.speakerIndex == localSpeakerIndex }
                .map { it.toSampleRange(sampleRate, samples.size) }
        val blockingRanges =
            turns.filter { it.speakerIndex != localSpeakerIndex }
                .map { it.toSampleRange(sampleRate, samples.size) }
        val bestRange =
            targetRanges.asSequence()
                .flatMap { target -> subtractRanges(target, blockingRanges).asSequence() }
                .filter { range -> range.last - range.first + 1 >= MINIMUM_EMBEDDING_SAMPLES }
                .maxByOrNull { range -> range.last - range.first + 1 }
                ?: return null
        val endExclusive = minOf(
            bestRange.last + 1,
            bestRange.first + MAXIMUM_EMBEDDING_SAMPLES,
        )
        return samples.copyOfRange(bestRange.first, endExclusive)
    }

    private fun DiarizationTurn.toSampleRange(
        sampleRate: Int,
        maximumSamples: Int,
    ): IntRange {
        val start =
            (startSeconds * sampleRate).toInt()
                .coerceIn(0, maximumSamples - 1)
        val endExclusive =
            ceil(endSeconds * sampleRate).toInt()
                .coerceIn(start + 1, maximumSamples)
        return start until endExclusive
    }

    private fun subtractRanges(
        source: IntRange,
        blockers: List<IntRange>,
    ): List<IntRange> {
        var remaining = listOf(source)
        blockers.forEach { blocker ->
            remaining = remaining.flatMap { range ->
                when {
                    blocker.last < range.first || blocker.first > range.last -> listOf(range)
                    blocker.first <= range.first && blocker.last >= range.last -> emptyList()
                    blocker.first <= range.first -> listOf((blocker.last + 1)..range.last)
                    blocker.last >= range.last -> listOf(range.first until blocker.first)
                    else -> listOf(
                        range.first until blocker.first,
                        (blocker.last + 1)..range.last,
                    )
                }
            }.filterNot(IntRange::isEmpty)
        }
        return remaining
    }

    private fun createDiarizer(numberOfSpeakers: Int): OfflineSpeakerDiarization {
        val config = OfflineSpeakerDiarizationConfig(
            segmentation = OfflineSpeakerSegmentationModelConfig(
                pyannote = OfflineSpeakerSegmentationPyannoteModelConfig(
                    model = registry.segmentation.assetPath,
                ),
                numThreads = 2,
                debug = false,
                provider = "cpu",
            ),
            embedding = SpeakerEmbeddingExtractorConfig(
                model = registry.embedding.assetPath,
                numThreads = 2,
                debug = false,
                provider = "cpu",
            ),
            clustering = FastClusteringConfig(
                numClusters = numberOfSpeakers,
                threshold = 0.5f,
            ),
            minDurationOn = 0.3f,
            minDurationOff = 0.5f,
        )
        val storages = setOf(registry.segmentation.storage, registry.embedding.storage)
        require(storages.size == 1) { "说话人模型必须使用同一种存储边界" }
        return when (storages.single()) {
            SpeakerModelStorage.FLUTTER_ASSET ->
                OfflineSpeakerDiarization(context.assets, config)
            SpeakerModelStorage.FILE_SYSTEM ->
                OfflineSpeakerDiarization(config = config)
        }
    }

    private fun validateBounds(
        turns: List<DiarizationTurn>,
        durationSeconds: Double,
    ) {
        turns.forEach { turn ->
            require(turn.startSeconds >= 0) { "说话人区间起点越界" }
            require(turn.endSeconds > turn.startSeconds) { "说话人区间必须具有正时长" }
            require(turn.endSeconds <= durationSeconds + BOUNDS_TOLERANCE_SECONDS) {
                "说话人区间终点越界"
            }
            require(turn.speakerIndex >= 0) { "说话人索引不能为负数" }
        }
    }

    private companion object {
        const val BOUNDS_TOLERANCE_SECONDS = 0.02
        const val CURRENT_CANDIDATE_ID = "sherpa-v1.13.3-pyannote-3dspeaker"
        const val MAXIMUM_WINDOW_SAMPLES = 30 * 16_000
        const val MINIMUM_EMBEDDING_DURATION_MILLISECONDS = 1_500
        const val MINIMUM_EMBEDDING_SAMPLES =
            MINIMUM_EMBEDDING_DURATION_MILLISECONDS * 16_000 / 1_000
        const val MAXIMUM_EMBEDDING_SAMPLES = 10 * 16_000
    }
}
