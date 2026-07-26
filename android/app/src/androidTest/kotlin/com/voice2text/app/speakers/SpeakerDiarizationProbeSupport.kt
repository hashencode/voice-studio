package com.voice2text.app.speakers

import android.content.Context
import android.os.Build
import android.os.Debug
import android.os.PowerManager
import android.os.SystemClock
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

internal object SpeakerDiarizationProbeSupport {
    private const val CURRENT_CONTRACT_ID =
        "speaker-diarization-admission/current-sherpa-v2"
    private const val CURRENT_CONTRACT_SHA256 =
        "e3b8bbadb61a5a51620fde517f90510efbd174ec70bd4c421d56f2a67cbda2ac"
    private const val FALLBACK_CONTRACT_ID =
        "speaker-diarization-admission/sherpa-int8-fallback-v2"
    private const val FALLBACK_CONTRACT_SHA256 =
        "1e6d8f6ec965b68be724235db6c277677b29902aedf27f146c6281d17dbfdd4b"
    const val CURRENT_CANDIDATE_ID = "sherpa-v1.13.3-pyannote-3dspeaker"
    const val WINDOW_SAMPLES = 30 * 16_000
    const val OVERLAP_SAMPLES = 5 * 16_000
    const val NUM_THREADS = 2
    const val RECONCILIATION_THRESHOLD = 0.8
    const val SEGMENTATION_SHA256 =
        "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079"
    const val SEGMENTATION_BYTES = 5_992_913L
    const val EMBEDDING_SHA256 =
        "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b"
    const val EMBEDDING_BYTES = 39_593_761L
    const val FUNCTIONAL_SHA256 =
        "7e2757eb30176edc36a2c14a6511bbf297caa5dbfa9541e119cd94fd23a6d4ec"
    const val RESOURCE_SHA256 =
        "6a4f0849cee47ad9daecac04d92977c8cf6b48de1dd43849ad60852de5b336c3"

    fun root(context: Context) = File(context.filesDir, "speaker-diarization")

    fun candidateId(): String =
        androidx.test.platform.app.InstrumentationRegistry.getArguments()
            .getString("speakerDiarizationCandidate")
            ?: CURRENT_CANDIDATE_ID

    fun contractId(): String =
        if (candidateId() == SelectedFallbackSpeakerDiarizationCandidate.ID) {
            FALLBACK_CONTRACT_ID
        } else {
            CURRENT_CONTRACT_ID
        }

    fun contractSha256(): String =
        if (candidateId() == SelectedFallbackSpeakerDiarizationCandidate.ID) {
            FALLBACK_CONTRACT_SHA256
        } else {
            CURRENT_CONTRACT_SHA256
        }

    fun segmentation(context: Context) =
        File(
            root(context),
            if (candidateId() == SelectedFallbackSpeakerDiarizationCandidate.ID) {
                "models/pyannote-segmentation-3-0-int8.onnx"
            } else {
                "models/pyannote-segmentation-3-0.onnx"
            },
        )

    fun embedding(context: Context) =
        File(root(context), "models/3dspeaker-eres2net-base.onnx")

    fun functionalFixture(context: Context) =
        File(root(context), "fixtures/speaker-functional-5m.wav")

    fun resourceFixture(context: Context) =
        File(root(context), "fixtures/speaker-resource-120m.wav")

    fun output(context: Context, name: String) =
        File(context.filesDir, "device-evidence/$name").apply {
            parentFile?.mkdirs()
        }

    fun candidateRegistry(context: Context): SpeakerDiarizationModelRegistry =
        if (candidateId() == SelectedFallbackSpeakerDiarizationCandidate.ID) {
            SelectedFallbackSpeakerDiarizationCandidate.registry(
                context = context,
                segmentationFile = segmentation(context),
                embeddingFile = embedding(context),
            )
        } else {
            SpeakerDiarizationModelRegistry(
                context = context,
                segmentation =
                    SpeakerDiarizationModelRegistry.candidateSegmentation.copy(
                        assetPath = segmentation(context).absolutePath,
                        storage = SpeakerModelStorage.FILE_SYSTEM,
                    ),
                embedding =
                    SpeakerDiarizationModelRegistry.candidateEmbedding.copy(
                        assetPath = embedding(context).absolutePath,
                        storage = SpeakerModelStorage.FILE_SYSTEM,
                    ),
            )
        }

    fun configuration(): JSONObject =
        JSONObject()
            .put("windowSamples", WINDOW_SAMPLES)
            .put("overlapSamples", OVERLAP_SAMPLES)
            .put("numThreads", NUM_THREADS)
            .put("reconciliationThreshold", RECONCILIATION_THRESHOLD)

    fun deviceIdentity(
        context: Context,
        maximumThermalStatusRaw: Int,
    ): JSONObject {
        return JSONObject()
            .put("manufacturer", Build.MANUFACTURER)
            .put("model", Build.MODEL)
            .put("sdkInt", Build.VERSION.SDK_INT)
            .put("buildFingerprint", Build.FINGERPRINT)
            .put("maximumThermalStatusRaw", maximumThermalStatusRaw)
            .put("maximumThermalStatusName", thermalName(maximumThermalStatusRaw))
    }

    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(1024 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }

    fun currentThermalStatus(context: Context): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0
        return context.getSystemService(PowerManager::class.java)
            ?.currentThermalStatus
            ?: 0
    }

    fun thermalName(raw: Int): String = when (raw) {
        0 -> "none"
        1 -> "light"
        2 -> "moderate"
        3 -> "severe"
        4 -> "critical"
        5 -> "emergency"
        6 -> "shutdown"
        else -> error("unknown Android thermal status: $raw")
    }

    fun elapsedMs(startedNanos: Long): Long =
        (SystemClock.elapsedRealtimeNanos() - startedNanos) / 1_000_000L

    class PeakMemorySampler {
        private val running = AtomicBoolean(false)
        private var baselinePssKiB = 0L
        private var peakPssKiB = 0L
        private var peakJavaBytes = 0L
        private var peakNativeBytes = 0L
        private var maximumThermalStatusRaw = 0
        private lateinit var context: Context
        private val thread =
            Thread {
                while (running.get()) {
                    val runtime = Runtime.getRuntime()
                    peakPssKiB = maxOf(peakPssKiB, Debug.getPss().toLong())
                    peakJavaBytes =
                        maxOf(
                            peakJavaBytes,
                            runtime.totalMemory() - runtime.freeMemory(),
                        )
                    peakNativeBytes =
                        maxOf(peakNativeBytes, Debug.getNativeHeapAllocatedSize())
                    maximumThermalStatusRaw =
                        maxOf(maximumThermalStatusRaw, currentThermalStatus(context))
                    SystemClock.sleep(50)
                }
            }

        fun start(context: Context): PeakMemorySampler {
            this.context = context
            baselinePssKiB = Debug.getPss().toLong()
            peakPssKiB = baselinePssKiB
            maximumThermalStatusRaw = currentThermalStatus(context)
            running.set(true)
            thread.start()
            return this
        }

        fun stop(): ProbeMeasurements {
            running.set(false)
            thread.join(2_000)
            return ProbeMeasurements(
                baselinePssKiB = baselinePssKiB,
                peakPssKiB = peakPssKiB,
                peakJavaBytes = peakJavaBytes,
                peakNativeBytes = peakNativeBytes,
                maximumThermalStatusRaw = maximumThermalStatusRaw,
            )
        }
    }

    data class ProbeMeasurements(
        val baselinePssKiB: Long,
        val peakPssKiB: Long,
        val peakJavaBytes: Long,
        val peakNativeBytes: Long,
        val maximumThermalStatusRaw: Int,
    )
}
