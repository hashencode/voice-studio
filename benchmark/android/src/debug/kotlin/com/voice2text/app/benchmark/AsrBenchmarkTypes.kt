package com.voice2text.app.benchmark

import java.io.File

internal data class AsrBenchmarkPaths(
    val root: File,
) {
    val manifestFile: File = File(root, "manifest.json")
    val profilesFile: File = File(root, "profiles.json")
    val modelsDir: File = File(root, "models")
    val resultsDir: File = File(root, "results")
}

internal data class AsrBenchmarkModel(
    val id: String,
    val displayName: String,
    val pretrainedModel: String,
    val family: String,
    val languages: Set<String>,
    val extractedDir: String,
    val numThreads: Int,
    val requiredFiles: Map<String, String>,
)

internal data class AsrBenchmarkAudioCase(
    val id: String,
    val language: String,
    val wav: String,
    val reference: String,
)

internal data class AsrBenchmarkVadConfig(
    val model: String,
    val sampleRate: Int,
    val threshold: Float,
    val minSilenceDurationSec: Float,
    val minSpeechDurationSec: Float,
    val windowSize: Int,
    val maxSpeechDurationSec: Float,
    val numThreads: Int,
)

internal data class AsrBenchmarkProfile(
    val id: String,
    val name: String,
    val route: String,
    val runClass: String,
    val mode: String?,
    val vadType: String?,
    val loadStrategy: String,
    val numThreads: Int?,
    val warmupIterations: Int,
    val frameMs: Int,
    val speechThreshold: Double,
    val minSpeechMs: Int,
    val endSilenceMs: Int,
    val maxSegmentMs: Int,
    val preRollMs: Int,
    val maxQueuedSegments: Int,
    val modelIds: Set<String>?,
    val languages: Set<String>?,
    val vadOverrides: AsrBenchmarkVadOverrides?,
    val raw: String,
)

internal data class AsrBenchmarkVadOverrides(
    val threshold: Float?,
    val minSilenceDurationSec: Float?,
    val minSpeechDurationSec: Float?,
    val maxSpeechDurationSec: Float?,
)

internal data class AsrDecodeOutcome(
    val text: String,
    val wallMs: Long,
    val cpuMs: Long,
)

internal data class AsrMemorySnapshot(
    val javaHeapUsedBytes: Long,
    val nativeHeapAllocatedBytes: Long,
)
