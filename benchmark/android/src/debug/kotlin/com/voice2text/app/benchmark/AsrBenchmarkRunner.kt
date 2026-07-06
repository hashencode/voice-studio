package com.voice2text.app.benchmark

import android.content.Context
import android.os.Debug
import android.os.SystemClock
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineParaformerModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineStream
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import com.k2fsa.sherpa.onnx.WaveReader
import java.io.File
import java.util.Locale
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt
import org.json.JSONArray
import org.json.JSONObject

internal class AsrBenchmarkRunner(
    private val context: Context,
) {
    fun run(segmentWindowMs: Int): Map<String, Any> {
        require(segmentWindowMs > 0) { "segmentWindowMs must be positive" }

        val paths = AsrBenchmarkPaths(File(context.filesDir, "asr_benchmark"))
        if (!paths.manifestFile.exists()) {
            throw IllegalStateException("Benchmark manifest not found: ${paths.manifestFile.absolutePath}")
        }
        paths.resultsDir.mkdirs()

        val manifest = JSONObject(paths.manifestFile.readText())
        val models = parseModels(manifest)
        val audioCases = parseAudioCases(manifest)
        val vadConfig = parseVadConfig(manifest)
        val profiles = parseProfiles(paths, manifest, segmentWindowMs)
        val results = JSONArray()
        val failures = JSONArray()

        if (profiles.any { it.mode == MODE_VAD_SEGMENTED_OFFLINE || it.vadType == VAD_TYPE_SILERO }) {
            if (vadConfig == null) {
                throw IllegalStateException("VAD benchmark profiles require a vad config in manifest.json")
            }
            val vadModel = File(paths.root, vadConfig.model)
            if (!vadModel.isFile) {
                throw IllegalStateException("VAD model not found: ${vadModel.absolutePath}")
            }
        }

        for (model in models) {
            val modelDir = File(paths.modelsDir, model.extractedDir)
            val modelSizeBytes = directorySize(modelDir)
            val validationError = validateModelFiles(model, modelDir)
            if (validationError != null) {
                failures.put(failureJson(model.id, null, "model_validation", validationError))
                continue
            }

            for (profile in profiles) {
                if (!profileAppliesToModel(profile, model)) continue

                var sharedLoaded: LoadedRecognizer? = null
                if (profile.loadStrategy == LOAD_STRATEGY_SHARED) {
                    sharedLoaded = try {
                        loadRecognizer(model, modelDir, profile.numThreads ?: model.numThreads)
                    } catch (e: Exception) {
                        failures.put(failureJson(model.id, null, "recognizer_load:${profile.id}", e.message ?: "unknown error"))
                        continue
                    }
                }

                try {
                    for (audioCase in audioCases) {
                        if (!model.languages.contains(audioCase.language)) continue
                        if (!profileAppliesToAudio(profile, audioCase)) continue

                        try {
                            results.put(
                                runProfileAudioCase(
                                    model = model,
                                    modelDir = modelDir,
                                    modelSizeBytes = modelSizeBytes,
                                    audioCase = audioCase,
                                    root = paths.root,
                                    profile = profile,
                                    sharedLoaded = sharedLoaded,
                                    baseVadConfig = vadConfig,
                                ),
                            )
                        } catch (e: Exception) {
                            failures.put(failureJson(model.id, audioCase.id, "profile:${profile.id}", e.message ?: "unknown error"))
                        }
                    }
                } finally {
                    try {
                        sharedLoaded?.recognizer?.release()
                    } catch (_: Exception) {
                    }
                }
            }
        }

        if (results.length() == 0 && failures.length() == 0) {
            throw IllegalStateException("No benchmark pairs were runnable")
        }

        val report = JSONObject()
            .put("schemaVersion", 2)
            .put("createdAtMs", System.currentTimeMillis())
            .put("segmentWindowMs", segmentWindowMs)
            .put("profilesConfigured", profiles.size)
            .put("profileIds", JSONArray(profiles.map { it.id }))
            .put("modelsConfigured", models.size)
            .put("audioCasesConfigured", audioCases.size)
            .put("results", results)
            .put("failures", failures)
        if (vadConfig != null) {
            report.put(
                "vadConfig",
                JSONObject()
                    .put("model", vadConfig.model)
                    .put("sampleRate", vadConfig.sampleRate)
                    .put("threshold", vadConfig.threshold.toDouble())
                    .put("minSilenceDurationSec", vadConfig.minSilenceDurationSec.toDouble())
                    .put("minSpeechDurationSec", vadConfig.minSpeechDurationSec.toDouble())
                    .put("windowSize", vadConfig.windowSize)
                    .put("maxSpeechDurationSec", vadConfig.maxSpeechDurationSec.toDouble())
                    .put("numThreads", vadConfig.numThreads),
            )
        }

        val reportFile = File(paths.resultsDir, "asr-benchmark-${System.currentTimeMillis()}.json")
        reportFile.writeText(report.toString(2))

        return hashMapOf(
            "reportPath" to reportFile.absolutePath,
            "resultCount" to results.length(),
            "failureCount" to failures.length(),
            "profilesConfigured" to profiles.size,
            "modelsConfigured" to models.size,
            "audioCasesConfigured" to audioCases.size,
        )
    }

    private data class LoadedRecognizer(
        val recognizer: OfflineRecognizer,
        val loadMs: Long,
    )

    private data class DecodeStats(
        var totalRecognizerLoadMs: Long = 0L,
        var recognizerLoadCount: Int = 0,
        var warmupWallMs: Long = 0L,
    )

    private fun parseModels(manifest: JSONObject): List<AsrBenchmarkModel> {
        val models = manifest.getJSONArray("models")
        return (0 until models.length()).map { index ->
            val item = models.getJSONObject(index)
            AsrBenchmarkModel(
                id = item.getString("id"),
                displayName = item.optString("displayName", item.getString("id")),
                pretrainedModel = item.optString("pretrainedModel", item.getString("id")),
                family = item.getString("family"),
                languages = item.getJSONArray("languages").toStringSet(),
                extractedDir = item.getString("extractedDir"),
                numThreads = item.optInt("numThreads", 2).coerceAtLeast(1),
                requiredFiles = item.getJSONObject("requiredFiles").toStringMap(),
            )
        }
    }

    private fun parseAudioCases(manifest: JSONObject): List<AsrBenchmarkAudioCase> {
        val cases = manifest.getJSONArray("audioCases")
        return (0 until cases.length()).map { index ->
            val item = cases.getJSONObject(index)
            AsrBenchmarkAudioCase(
                id = item.getString("id"),
                language = item.getString("language"),
                wav = item.getString("wav"),
                reference = item.getString("reference"),
            )
        }
    }

    private fun parseProfiles(paths: AsrBenchmarkPaths, manifest: JSONObject, segmentWindowMs: Int): List<AsrBenchmarkProfile> {
        if (!paths.profilesFile.isFile) {
            return parseModes(manifest).map { mode ->
                AsrBenchmarkProfile(
                    id = "legacy-$mode",
                    name = "Legacy $mode",
                    route = ROUTE_STANDARD,
                    runClass = RUN_CLASS_WARM,
                    mode = mode,
                    vadType = null,
                    loadStrategy = LOAD_STRATEGY_SHARED,
                    numThreads = null,
                    warmupIterations = 0,
                    frameMs = 100,
                    speechThreshold = 520.0,
                    minSpeechMs = 320,
                    endSilenceMs = 720,
                    maxSegmentMs = segmentWindowMs,
                    preRollMs = 0,
                    maxQueuedSegments = 2,
                    modelIds = null,
                    languages = null,
                    vadOverrides = null,
                    raw = JSONObject().put("mode", mode).toString(),
                )
            }
        }

        val payload = JSONObject(paths.profilesFile.readText())
        val profiles = payload.getJSONArray("profiles")
        return (0 until profiles.length()).map { index ->
            val item = profiles.getJSONObject(index)
            val vad = item.optJSONObject("vad")
            AsrBenchmarkProfile(
                id = item.getString("id"),
                name = item.optString("name", item.getString("id")),
                route = item.getString("route"),
                runClass = item.optString("runClass", RUN_CLASS_WARM),
                mode = item.optNullableString("mode"),
                vadType = item.optNullableString("vadType"),
                loadStrategy = item.optString("loadStrategy", LOAD_STRATEGY_SHARED),
                numThreads = if (item.has("numThreads")) item.optInt("numThreads").coerceAtLeast(1) else null,
                warmupIterations = item.optInt("warmupIterations", 0).coerceAtLeast(0),
                frameMs = item.optInt("frameMs", 100).coerceAtLeast(10),
                speechThreshold = item.optDouble("speechThreshold", 520.0),
                minSpeechMs = item.optInt("minSpeechMs", 320).coerceAtLeast(0),
                endSilenceMs = item.optInt("endSilenceMs", 720).coerceAtLeast(0),
                maxSegmentMs = item.optInt("maxSegmentMs", segmentWindowMs).coerceAtLeast(1),
                preRollMs = item.optInt("preRollMs", 0).coerceAtLeast(0),
                maxQueuedSegments = item.optInt("maxQueuedSegments", 2).coerceAtLeast(1),
                modelIds = item.optJSONArray("modelIds")?.toStringSet(),
                languages = item.optJSONArray("languages")?.toStringSet(),
                vadOverrides = vad?.let {
                    AsrBenchmarkVadOverrides(
                        threshold = if (it.has("threshold")) it.optDouble("threshold").toFloat() else null,
                        minSilenceDurationSec = if (it.has("minSilenceDurationSec")) it.optDouble("minSilenceDurationSec").toFloat() else null,
                        minSpeechDurationSec = if (it.has("minSpeechDurationSec")) it.optDouble("minSpeechDurationSec").toFloat() else null,
                        maxSpeechDurationSec = if (it.has("maxSpeechDurationSec")) it.optDouble("maxSpeechDurationSec").toFloat() else null,
                    )
                },
                raw = item.toString(),
            )
        }
    }

    private fun parseModes(manifest: JSONObject): List<String> {
        val configured = manifest.optJSONArray("modes") ?: return listOf(MODE_OFFLINE, MODE_SEGMENTED_OFFLINE)
        val modes = (0 until configured.length()).map { configured.getString(it) }
        val allowed = setOf(MODE_OFFLINE, MODE_SEGMENTED_OFFLINE, MODE_VAD_SEGMENTED_OFFLINE)
        val unknown = modes.filterNot { allowed.contains(it) }
        require(unknown.isEmpty()) { "unsupported benchmark modes: ${unknown.joinToString()}" }
        return modes.distinct()
    }

    private fun parseVadConfig(manifest: JSONObject): AsrBenchmarkVadConfig? {
        val vad = manifest.optJSONObject("vad") ?: return null
        return AsrBenchmarkVadConfig(
            model = vad.getString("model"),
            sampleRate = vad.optInt("sampleRate", 16000),
            threshold = vad.optDouble("threshold", 0.2).toFloat(),
            minSilenceDurationSec = vad.optDouble("minSilenceDurationSec", 0.25).toFloat(),
            minSpeechDurationSec = vad.optDouble("minSpeechDurationSec", 0.25).toFloat(),
            windowSize = vad.optInt("windowSize", 512),
            maxSpeechDurationSec = vad.optDouble("maxSpeechDurationSec", 5.0).toFloat(),
            numThreads = vad.optInt("numThreads", 1).coerceAtLeast(1),
        )
    }

    private fun profileAppliesToModel(profile: AsrBenchmarkProfile, model: AsrBenchmarkModel): Boolean {
        return profile.modelIds?.contains(model.id) ?: true
    }

    private fun profileAppliesToAudio(profile: AsrBenchmarkProfile, audioCase: AsrBenchmarkAudioCase): Boolean {
        return profile.languages?.contains(audioCase.language) ?: true
    }

    private fun profileVadConfig(base: AsrBenchmarkVadConfig?, profile: AsrBenchmarkProfile): AsrBenchmarkVadConfig {
        val current = requireNotNull(base) { "VAD config is required for profile ${profile.id}" }
        val overrides = profile.vadOverrides ?: return current
        return current.copy(
            threshold = overrides.threshold ?: current.threshold,
            minSilenceDurationSec = overrides.minSilenceDurationSec ?: current.minSilenceDurationSec,
            minSpeechDurationSec = overrides.minSpeechDurationSec ?: current.minSpeechDurationSec,
            maxSpeechDurationSec = overrides.maxSpeechDurationSec ?: current.maxSpeechDurationSec,
        )
    }

    private fun validateModelFiles(model: AsrBenchmarkModel, modelDir: File): String? {
        if (!modelDir.isDirectory) {
            return "model directory not found: ${modelDir.absolutePath}"
        }
        val missing = model.requiredFiles.values.filter { !File(modelDir, it).isFile }
        if (missing.isNotEmpty()) {
            return "missing required files: ${missing.joinToString()}"
        }
        return null
    }

    private fun loadRecognizer(model: AsrBenchmarkModel, modelDir: File, numThreads: Int): LoadedRecognizer {
        val started = SystemClock.elapsedRealtimeNanos()
        val tokensFile = File(modelDir, model.requiredFiles.getValue("tokens")).absolutePath
        val featureConfig = FeatureConfig(
            sampleRate = 16000,
            featureDim = 80,
            dither = 0.0f,
        )
        val modelConfig = createModelConfig(model, modelDir, tokensFile, numThreads)
        val config = OfflineRecognizerConfig(
            featConfig = featureConfig,
            modelConfig = modelConfig,
        )
        val recognizer = OfflineRecognizer(null as android.content.res.AssetManager?, config)
        return LoadedRecognizer(
            recognizer = recognizer,
            loadMs = elapsedMsSince(started),
        )
    }

    private fun createModelConfig(
        model: AsrBenchmarkModel,
        modelDir: File,
        tokensFile: String,
        numThreads: Int,
    ): OfflineModelConfig {
        val common = mapRequiredFiles(model, modelDir)
        return when (model.family) {
            "paraformer" -> OfflineModelConfig(
                paraformer = OfflineParaformerModelConfig(model = common.getValue("model")),
                numThreads = numThreads,
                debug = false,
                provider = "cpu",
                modelType = "paraformer",
                tokens = tokensFile,
            )

            else -> throw IllegalArgumentException("Unsupported benchmark model family: ${model.family}")
        }
    }

    private fun mapRequiredFiles(model: AsrBenchmarkModel, modelDir: File): Map<String, String> {
        return model.requiredFiles.mapValues { (_, path) -> File(modelDir, path).absolutePath }
    }

    private fun runProfileAudioCase(
        model: AsrBenchmarkModel,
        modelDir: File,
        modelSizeBytes: Long,
        audioCase: AsrBenchmarkAudioCase,
        root: File,
        profile: AsrBenchmarkProfile,
        sharedLoaded: LoadedRecognizer?,
        baseVadConfig: AsrBenchmarkVadConfig?,
    ): JSONObject {
        val wavFile = File(root, audioCase.wav)
        if (!wavFile.isFile) {
            throw IllegalStateException("audio file not found: ${wavFile.absolutePath}")
        }
        val referenceFile = File(root, audioCase.reference)
        val reference = if (referenceFile.isFile) referenceFile.readText().trim() else null
        val wave = WaveReader.Companion.readWave(wavFile.absolutePath)
        val durationSec = wave.samples.size.toDouble() / wave.sampleRate.toDouble()
        val numThreads = profile.numThreads ?: model.numThreads
        val stats = DecodeStats()
        var localLoaded: LoadedRecognizer? = null

        val activeLoaded = when (profile.loadStrategy) {
            LOAD_STRATEGY_SHARED -> sharedLoaded
                ?: throw IllegalStateException("shared recognizer missing for profile ${profile.id}")
            LOAD_STRATEGY_PER_CASE -> {
                loadRecognizer(model, modelDir, numThreads).also {
                    localLoaded = it
                    stats.totalRecognizerLoadMs += it.loadMs
                    stats.recognizerLoadCount += 1
                }
            }
            LOAD_STRATEGY_PER_SEGMENT -> null
            else -> throw IllegalArgumentException("Unsupported load strategy: ${profile.loadStrategy}")
        }

        fun decodeOne(segmentSamples: FloatArray, sampleRate: Int): AsrDecodeOutcome {
            if (profile.loadStrategy == LOAD_STRATEGY_PER_SEGMENT) {
                val loaded = loadRecognizer(model, modelDir, numThreads)
                stats.totalRecognizerLoadMs += loaded.loadMs
                stats.recognizerLoadCount += 1
                return try {
                    decodeSamples(loaded.recognizer, segmentSamples, sampleRate)
                } finally {
                    try {
                        loaded.recognizer.release()
                    } catch (_: Exception) {
                    }
                }
            }
            return decodeSamples(requireNotNull(activeLoaded).recognizer, segmentSamples, sampleRate)
        }

        try {
            if (profile.warmupIterations > 0 && activeLoaded != null) {
                stats.warmupWallMs = runWarmup(activeLoaded.recognizer, wave.samples, wave.sampleRate, profile.warmupIterations)
            }

            val memoryBefore = memorySnapshot()
            val result = when (profile.route) {
                ROUTE_STANDARD -> runStandardProfile(profile, wave.samples, wave.sampleRate, root, baseVadConfig, ::decodeOne)
                ROUTE_REALTIME_REPLAY -> runRealtimeReplayProfile(profile, wave.samples, wave.sampleRate, root, baseVadConfig, ::decodeOne)
                else -> throw IllegalArgumentException("Unsupported benchmark route: ${profile.route}")
            }
            val memoryAfter = memorySnapshot()
            val text = result.getString("text")
            val decodeWallMs = result.getLong("decodeWallMs")
            val operationWallMs = decodeWallMs + stats.totalRecognizerLoadMs
            val output = JSONObject()
                .put("modelId", model.id)
                .put("displayName", model.displayName)
                .put("pretrainedModel", model.pretrainedModel)
                .put("family", model.family)
                .put("modelDir", modelDir.name)
                .put("modelSizeBytes", modelSizeBytes)
                .put("language", audioCase.language)
                .put("audioCaseId", audioCase.id)
                .put("route", profile.route)
                .put("profileId", profile.id)
                .put("profileName", profile.name)
                .put("runClass", profile.runClass)
                .put("loadStrategy", profile.loadStrategy)
                .put("profileNumThreads", numThreads)
                .put("warmupIterations", profile.warmupIterations)
                .put("warmupWallMs", stats.warmupWallMs)
                .put("profile", JSONObject(profile.raw))
                .put("mode", result.optString("mode", profile.mode ?: profile.route))
                .put("sampleRate", wave.sampleRate)
                .put("durationSec", durationSec)
                .put("recognizerLoadMs", activeLoaded?.loadMs ?: localLoaded?.loadMs ?: 0L)
                .put("totalRecognizerLoadMs", stats.totalRecognizerLoadMs)
                .put("recognizerLoadCount", stats.recognizerLoadCount)
                .put("operationWallMs", operationWallMs)
                .put("operationRtf", if (durationSec > 0.0) operationWallMs / 1000.0 / durationSec else JSONObject.NULL)
                .put("rtf", if (durationSec > 0.0) decodeWallMs / 1000.0 / durationSec else JSONObject.NULL)
                .put("emptyResult", text.isBlank())
                .put("text", text)
                .put("javaHeapBeforeBytes", memoryBefore.javaHeapUsedBytes)
                .put("javaHeapAfterBytes", memoryAfter.javaHeapUsedBytes)
                .put("nativeHeapBeforeBytes", memoryBefore.nativeHeapAllocatedBytes)
                .put("nativeHeapAfterBytes", memoryAfter.nativeHeapAllocatedBytes)

            copyResultFields(result, output)
            addSegmentSummary(output)
            addAccuracy(output, audioCase.language, reference, text)
            return output
        } finally {
            try {
                localLoaded?.recognizer?.release()
            } catch (_: Exception) {
            }
        }
    }

    private fun runStandardProfile(
        profile: AsrBenchmarkProfile,
        samples: FloatArray,
        sampleRate: Int,
        root: File,
        baseVadConfig: AsrBenchmarkVadConfig?,
        decodeOne: (FloatArray, Int) -> AsrDecodeOutcome,
    ): JSONObject {
        return when (val mode = profile.mode ?: MODE_OFFLINE) {
            MODE_SEGMENTED_OFFLINE -> decodeSegmented(samples, sampleRate, profile.maxSegmentMs, decodeOne)
                .put("mode", mode)
            MODE_VAD_SEGMENTED_OFFLINE -> decodeVadSegmented(
                samples = samples,
                sampleRate = sampleRate,
                vadConfig = profileVadConfig(baseVadConfig, profile),
                benchmarkRoot = root,
                decodeOne = decodeOne,
            ).put("mode", mode)
            MODE_OFFLINE -> {
                val outcome = decodeOne(samples, sampleRate)
                JSONObject()
                    .put("mode", mode)
                    .put("text", outcome.text)
                    .put("decodeWallMs", outcome.wallMs)
                    .put("decodeCpuMs", outcome.cpuMs)
                    .put("segmentCount", 1)
            }
            else -> throw IllegalArgumentException("Unsupported standard mode: $mode")
        }
    }

    private fun runRealtimeReplayProfile(
        profile: AsrBenchmarkProfile,
        samples: FloatArray,
        sampleRate: Int,
        root: File,
        baseVadConfig: AsrBenchmarkVadConfig?,
        decodeOne: (FloatArray, Int) -> AsrDecodeOutcome,
    ): JSONObject {
        return when (profile.vadType ?: VAD_TYPE_RMS) {
            VAD_TYPE_RMS -> decodeRealtimeRmsReplay(samples, sampleRate, profile, decodeOne)
            VAD_TYPE_SILERO -> decodeVadSegmented(
                samples = samples,
                sampleRate = sampleRate,
                vadConfig = profileVadConfig(baseVadConfig, profile),
                benchmarkRoot = root,
                decodeOne = decodeOne,
            )
                .put("mode", MODE_REALTIME_REPLAY)
                .put("vadType", VAD_TYPE_SILERO)
                .put("frameMs", profile.frameMs)
            else -> throw IllegalArgumentException("Unsupported realtime replay VAD type: ${profile.vadType}")
        }
    }

    private fun runWarmup(
        recognizer: OfflineRecognizer,
        samples: FloatArray,
        sampleRate: Int,
        iterations: Int,
    ): Long {
        val sampleCount = min(samples.size, sampleRate * 3)
        if (sampleCount <= 0) return 0L
        val warmupSamples = samples.copyOfRange(0, sampleCount)
        val started = SystemClock.elapsedRealtimeNanos()
        repeat(iterations) {
            decodeSamples(recognizer, warmupSamples, sampleRate)
        }
        return elapsedMsSince(started)
    }

    private fun decodeSamples(
        recognizer: OfflineRecognizer,
        samples: FloatArray,
        sampleRate: Int,
    ): AsrDecodeOutcome {
        var stream: OfflineStream? = null
        val startedWall = SystemClock.elapsedRealtimeNanos()
        val startedCpu = Debug.threadCpuTimeNanos()
        return try {
            stream = recognizer.createStream()
            stream.acceptWaveform(samples, sampleRate)
            recognizer.decode(stream)
            AsrDecodeOutcome(
                text = recognizer.getResult(stream).text.trim(),
                wallMs = elapsedMsSince(startedWall),
                cpuMs = elapsedThreadCpuMsSince(startedCpu),
            )
        } finally {
            try {
                stream?.release()
            } catch (_: Exception) {
            }
        }
    }

    private fun decodeSegmented(
        samples: FloatArray,
        sampleRate: Int,
        segmentWindowMs: Int,
        decodeOne: (FloatArray, Int) -> AsrDecodeOutcome,
    ): JSONObject {
        val samplesPerSegment = ((sampleRate * segmentWindowMs) / 1000.0).roundToInt().coerceAtLeast(1)
        val startedWall = SystemClock.elapsedRealtimeNanos()
        val startedCpu = Debug.threadCpuTimeNanos()
        val segments = JSONArray()
        val texts = mutableListOf<String>()
        var start = 0
        var index = 0

        while (start < samples.size) {
            val end = min(start + samplesPerSegment, samples.size)
            val segmentSamples = samples.copyOfRange(start, end)
            val outcome = decodeOne(segmentSamples, sampleRate)
            if (outcome.text.isNotBlank()) texts.add(outcome.text)
            segments.put(
                JSONObject()
                    .put("index", index)
                    .put("startMs", ((start.toDouble() / sampleRate) * 1000.0).roundToInt())
                    .put("endMs", ((end.toDouble() / sampleRate) * 1000.0).roundToInt())
                    .put("sampleCount", segmentSamples.size)
                    .put("decodeWallMs", outcome.wallMs)
                    .put("decodeCpuMs", outcome.cpuMs)
                    .put("emptyResult", outcome.text.isBlank())
                    .put("text", outcome.text),
            )
            start = end
            index += 1
        }

        return JSONObject()
            .put("text", texts.joinToString(" ").trim())
            .put("decodeWallMs", elapsedMsSince(startedWall))
            .put("decodeCpuMs", elapsedThreadCpuMsSince(startedCpu))
            .put("segmentCount", index)
            .put("segments", segments)
    }

    private fun decodeVadSegmented(
        samples: FloatArray,
        sampleRate: Int,
        vadConfig: AsrBenchmarkVadConfig,
        benchmarkRoot: File,
        decodeOne: (FloatArray, Int) -> AsrDecodeOutcome,
    ): JSONObject {
        val vadModelFile = File(benchmarkRoot, vadConfig.model)
        val nativeConfig = VadModelConfig(
            sileroVadModelConfig = SileroVadModelConfig(
                model = vadModelFile.absolutePath,
                threshold = vadConfig.threshold,
                minSilenceDuration = vadConfig.minSilenceDurationSec,
                minSpeechDuration = vadConfig.minSpeechDurationSec,
                windowSize = vadConfig.windowSize,
                maxSpeechDuration = vadConfig.maxSpeechDurationSec,
            ),
            sampleRate = vadConfig.sampleRate,
            numThreads = vadConfig.numThreads,
            provider = "cpu",
            debug = false,
        )
        val vad = Vad(null as android.content.res.AssetManager?, nativeConfig)
        val startedWall = SystemClock.elapsedRealtimeNanos()
        val startedCpu = Debug.threadCpuTimeNanos()
        val segments = JSONArray()
        val texts = mutableListOf<String>()
        var index = 0
        var speechSampleCount = 0L

        try {
            fun drainDetectedSegments() {
                while (!vad.empty()) {
                    val speech = vad.front()
                    val segmentSamples = speech.samples
                    val startSample = speech.start
                    val endSample = startSample + segmentSamples.size
                    val outcome = decodeOne(segmentSamples, sampleRate)
                    if (outcome.text.isNotBlank()) texts.add(outcome.text)
                    speechSampleCount += segmentSamples.size.toLong()
                    segments.put(
                        JSONObject()
                            .put("index", index)
                            .put("startMs", ((startSample.toDouble() / sampleRate) * 1000.0).roundToInt())
                            .put("endMs", ((endSample.toDouble() / sampleRate) * 1000.0).roundToInt())
                            .put("sampleCount", segmentSamples.size)
                            .put("decodeWallMs", outcome.wallMs)
                            .put("decodeCpuMs", outcome.cpuMs)
                            .put("emptyResult", outcome.text.isBlank())
                            .put("text", outcome.text),
                    )
                    vad.pop()
                    index += 1
                }
            }

            val vadChunkSamples = (sampleRate / 10).coerceAtLeast(vadConfig.windowSize)
            var start = 0
            while (start < samples.size) {
                val end = min(start + vadChunkSamples, samples.size)
                vad.acceptWaveform(samples.copyOfRange(start, end))
                drainDetectedSegments()
                start = end
            }
            vad.flush()
            drainDetectedSegments()
        } finally {
            try {
                vad.release()
            } catch (_: Exception) {
            }
        }

        if (index == 0) {
            throw IllegalStateException("VAD detected no speech segments")
        }

        return JSONObject()
            .put("text", texts.joinToString(" ").trim())
            .put("decodeWallMs", elapsedMsSince(startedWall))
            .put("decodeCpuMs", elapsedThreadCpuMsSince(startedCpu))
            .put("segmentCount", index)
            .put("vadModel", vadModelFile.name)
            .put("vadSampleRate", vadConfig.sampleRate)
            .put("vadThreshold", vadConfig.threshold.toDouble())
            .put("vadMinSilenceDurationSec", vadConfig.minSilenceDurationSec.toDouble())
            .put("vadMinSpeechDurationSec", vadConfig.minSpeechDurationSec.toDouble())
            .put("vadMaxSpeechDurationSec", vadConfig.maxSpeechDurationSec.toDouble())
            .put("vadSpeechDurationSec", speechSampleCount.toDouble() / sampleRate.toDouble())
            .put("segments", segments)
    }

    private fun decodeRealtimeRmsReplay(
        samples: FloatArray,
        sampleRate: Int,
        profile: AsrBenchmarkProfile,
        decodeOne: (FloatArray, Int) -> AsrDecodeOutcome,
    ): JSONObject {
        val frameSamples = ((sampleRate * profile.frameMs) / 1000.0).roundToInt().coerceAtLeast(1)
        val preRollSamples = ((sampleRate * profile.preRollMs) / 1000.0).roundToInt().coerceAtLeast(0)
        val startedWall = SystemClock.elapsedRealtimeNanos()
        val startedCpu = Debug.threadCpuTimeNanos()
        val segments = JSONArray()
        val texts = mutableListOf<String>()
        var inSpeech = false
        var segmentStart = 0
        var lastSpeechEnd = 0
        var trailingSilenceMs = 0
        var speechSampleCount = 0L
        var index = 0

        fun finishSegment(endSample: Int) {
            val safeEnd = endSample.coerceIn(segmentStart, samples.size)
            if (safeEnd <= segmentStart) return
            val segmentSamples = samples.copyOfRange(segmentStart, safeEnd)
            val outcome = decodeOne(segmentSamples, sampleRate)
            if (outcome.text.isNotBlank()) texts.add(outcome.text)
            speechSampleCount += segmentSamples.size.toLong()
            segments.put(
                JSONObject()
                    .put("index", index)
                    .put("startMs", ((segmentStart.toDouble() / sampleRate) * 1000.0).roundToInt())
                    .put("endMs", ((safeEnd.toDouble() / sampleRate) * 1000.0).roundToInt())
                    .put("sampleCount", segmentSamples.size)
                    .put("decodeWallMs", outcome.wallMs)
                    .put("decodeCpuMs", outcome.cpuMs)
                    .put("emptyResult", outcome.text.isBlank())
                    .put("text", outcome.text),
            )
            index += 1
        }

        fun resetSegmenter() {
            inSpeech = false
            segmentStart = 0
            lastSpeechEnd = 0
            trailingSilenceMs = 0
        }

        var start = 0
        while (start < samples.size) {
            val end = min(start + frameSamples, samples.size)
            val frameDurationMs = (((end - start).toDouble() / sampleRate) * 1000.0).roundToInt().coerceAtLeast(1)
            val speech = rmsPcm16(samples, start, end) >= profile.speechThreshold

            if (!inSpeech && speech) {
                inSpeech = true
                segmentStart = max(0, start - preRollSamples)
                lastSpeechEnd = end
                trailingSilenceMs = 0
            } else if (inSpeech && speech) {
                lastSpeechEnd = end
                trailingSilenceMs = 0
            } else if (inSpeech) {
                trailingSilenceMs += frameDurationMs
            }

            if (inSpeech) {
                val segmentDurationMs = (((end - segmentStart).toDouble() / sampleRate) * 1000.0).roundToInt()
                val speechDurationMs = (((lastSpeechEnd - segmentStart).toDouble() / sampleRate) * 1000.0).roundToInt()
                if (
                    segmentDurationMs >= profile.maxSegmentMs ||
                    (trailingSilenceMs >= profile.endSilenceMs && speechDurationMs >= profile.minSpeechMs)
                ) {
                    finishSegment(end)
                    resetSegmenter()
                } else if (trailingSilenceMs >= profile.endSilenceMs && speechDurationMs < profile.minSpeechMs) {
                    resetSegmenter()
                }
            }
            start = end
        }

        if (inSpeech) {
            finishSegment(samples.size)
            resetSegmenter()
        }

        if (index == 0) {
            throw IllegalStateException("RMS replay detected no speech segments")
        }

        return JSONObject()
            .put("mode", MODE_REALTIME_REPLAY)
            .put("vadType", VAD_TYPE_RMS)
            .put("frameMs", profile.frameMs)
            .put("speechThreshold", profile.speechThreshold)
            .put("minSpeechMs", profile.minSpeechMs)
            .put("endSilenceMs", profile.endSilenceMs)
            .put("maxSegmentMs", profile.maxSegmentMs)
            .put("preRollMs", profile.preRollMs)
            .put("maxQueuedSegments", profile.maxQueuedSegments)
            .put("droppedSegmentCount", 0)
            .put("text", texts.joinToString(" ").trim())
            .put("decodeWallMs", elapsedMsSince(startedWall))
            .put("decodeCpuMs", elapsedThreadCpuMsSince(startedCpu))
            .put("segmentCount", index)
            .put("vadSpeechDurationSec", speechSampleCount.toDouble() / sampleRate.toDouble())
            .put("segments", segments)
    }

    private fun copyResultFields(from: JSONObject, to: JSONObject) {
        val keys = from.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (key != "text") {
                to.put(key, from.get(key))
            }
        }
    }

    private fun addSegmentSummary(output: JSONObject) {
        val segments = output.optJSONArray("segments") ?: return
        val decodeWallValues = mutableListOf<Long>()
        var nonEmpty = 0
        var totalSegmentDurationMs = 0L
        for (i in 0 until segments.length()) {
            val segment = segments.getJSONObject(i)
            if (!segment.optBoolean("emptyResult", false)) nonEmpty += 1
            decodeWallValues.add(segment.optLong("decodeWallMs", 0L))
            val startMs = segment.optLong("startMs", 0L)
            val endMs = segment.optLong("endMs", startMs)
            totalSegmentDurationMs += (endMs - startMs).coerceAtLeast(0L)
        }
        output
            .put("nonEmptySegmentCount", nonEmpty)
            .put("emptySegmentCount", segments.length() - nonEmpty)
            .put("totalSegmentDurationMs", totalSegmentDurationMs)
            .put("avgSegmentDurationMs", if (segments.length() > 0) totalSegmentDurationMs.toDouble() / segments.length() else JSONObject.NULL)
            .put("p50SegmentDecodeWallMs", percentile(decodeWallValues, 0.50))
            .put("p95SegmentDecodeWallMs", percentile(decodeWallValues, 0.95))
    }

    private fun addAccuracy(output: JSONObject, language: String, reference: String?, hypothesis: String) {
        if (reference.isNullOrBlank()) {
            output.put("accuracyMetric", JSONObject.NULL)
            return
        }

        if (language == "en") {
            val refWords = normalizeEnglish(reference)
            val hypWords = normalizeEnglish(hypothesis)
            val edits = editDistance(refWords, hypWords)
            output
                .put("accuracyMetric", "wer")
                .put("referenceLength", refWords.size)
                .put("editDistance", edits)
                .put("errorRate", if (refWords.isNotEmpty()) edits.toDouble() / refWords.size else JSONObject.NULL)
                .put("normalizedReference", refWords.joinToString(" "))
                .put("normalizedHypothesis", hypWords.joinToString(" "))
        } else {
            val refChars = normalizeCharacters(reference)
            val hypChars = normalizeCharacters(hypothesis)
            val edits = editDistance(refChars.map { it.toString() }, hypChars.map { it.toString() })
            output
                .put("accuracyMetric", "cer")
                .put("referenceLength", refChars.length)
                .put("editDistance", edits)
                .put("errorRate", if (refChars.isNotEmpty()) edits.toDouble() / refChars.length else JSONObject.NULL)
                .put("normalizedReference", refChars)
                .put("normalizedHypothesis", hypChars)
        }
    }

    private fun normalizeEnglish(text: String): List<String> {
        return text
            .lowercase(Locale.ROOT)
            .replace(Regex("[^a-z0-9\\s]+"), " ")
            .trim()
            .split(Regex("\\s+"))
            .filter { it.isNotBlank() }
    }

    private fun normalizeCharacters(text: String): String {
        return text
            .lowercase(Locale.ROOT)
            .filter { Character.isLetterOrDigit(it) }
    }

    private fun editDistance(reference: List<String>, hypothesis: List<String>): Int {
        if (reference.isEmpty()) return hypothesis.size
        if (hypothesis.isEmpty()) return reference.size

        var previous = IntArray(hypothesis.size + 1) { it }
        var current = IntArray(hypothesis.size + 1)

        for (i in 1..reference.size) {
            current[0] = i
            for (j in 1..hypothesis.size) {
                val cost = if (reference[i - 1] == hypothesis[j - 1]) 0 else 1
                current[j] = minOf(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + cost,
                )
            }
            val tmp = previous
            previous = current
            current = tmp
        }
        return previous[hypothesis.size]
    }

    private fun rmsPcm16(samples: FloatArray, start: Int, end: Int): Double {
        if (end <= start) return 0.0
        var sum = 0.0
        var count = 0
        for (i in start until end) {
            val value = (samples[i].coerceIn(-1.0f, 1.0f) * 32767.0).toDouble()
            sum += value * value
            count += 1
        }
        return if (count == 0) 0.0 else sqrt(sum / count)
    }

    private fun percentile(values: List<Long>, percentile: Double): Long {
        if (values.isEmpty()) return 0L
        val sorted = values.sorted()
        val index = ((sorted.size - 1) * percentile).roundToInt().coerceIn(0, sorted.size - 1)
        return sorted[index]
    }

    private fun memorySnapshot(): AsrMemorySnapshot {
        val runtime = Runtime.getRuntime()
        return AsrMemorySnapshot(
            javaHeapUsedBytes = runtime.totalMemory() - runtime.freeMemory(),
            nativeHeapAllocatedBytes = Debug.getNativeHeapAllocatedSize(),
        )
    }

    private fun directorySize(dir: File): Long {
        if (!dir.exists()) return 0L
        return dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
    }

    private fun failureJson(modelId: String, audioCaseId: String?, stage: String, message: String): JSONObject {
        return JSONObject()
            .put("modelId", modelId)
            .put("audioCaseId", audioCaseId ?: JSONObject.NULL)
            .put("stage", stage)
            .put("message", message)
    }

    private fun elapsedMsSince(startedNanos: Long): Long {
        return ((SystemClock.elapsedRealtimeNanos() - startedNanos) / 1_000_000L).coerceAtLeast(0L)
    }

    private fun elapsedThreadCpuMsSince(startedNanos: Long): Long {
        return ((Debug.threadCpuTimeNanos() - startedNanos) / 1_000_000L).coerceAtLeast(0L)
    }

    private fun JSONArray.toStringSet(): Set<String> {
        return (0 until length()).map { getString(it) }.toSet()
    }

    private fun JSONObject.toStringMap(): Map<String, String> {
        val output = mutableMapOf<String, String>()
        val keys = keys()
        while (keys.hasNext()) {
            val key = keys.next()
            output[key] = getString(key)
        }
        return output
    }

    private fun JSONObject.optNullableString(key: String): String? {
        if (!has(key) || isNull(key)) return null
        val value = optString(key)
        return value.ifBlank { null }
    }

    private companion object {
        const val ROUTE_STANDARD = "standard"
        const val ROUTE_REALTIME_REPLAY = "realtime_replay"
        const val RUN_CLASS_WARM = "warm"
        const val LOAD_STRATEGY_SHARED = "shared"
        const val LOAD_STRATEGY_PER_CASE = "per_case"
        const val LOAD_STRATEGY_PER_SEGMENT = "per_segment"
        const val MODE_OFFLINE = "offline"
        const val MODE_SEGMENTED_OFFLINE = "segmented_offline"
        const val MODE_VAD_SEGMENTED_OFFLINE = "vad_segmented_offline"
        const val MODE_REALTIME_REPLAY = "realtime_replay"
        const val VAD_TYPE_RMS = "rms"
        const val VAD_TYPE_SILERO = "silero"
    }
}
