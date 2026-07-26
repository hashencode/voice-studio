package com.voice2text.app.speakers

import android.content.Context
import android.os.Build
import java.io.File
import java.security.MessageDigest

internal enum class SpeakerModelStorage {
    FLUTTER_ASSET,
    FILE_SYSTEM,
}

internal data class SpeakerModelIdentity(
    val id: String,
    val assetPath: String,
    val sourceUrl: String,
    val sourceVersion: String,
    val expectedSha256: String?,
    val expectedBytes: Long?,
    val licenseId: String,
    val licenseSourceUrl: String,
    val distributionReviewed: Boolean,
    val storage: SpeakerModelStorage = SpeakerModelStorage.FLUTTER_ASSET,
)

internal enum class SpeakerDiarizationGateStatus {
    AVAILABLE,
    DEFERRED_MODEL_AND_FIXTURE_GATE,
    DEFERRED_FUNCTIONAL_GATE,
    DEFERRED_RESOURCE_GATE,
    MISSING_MODEL,
    WRONG_MODEL_HASH,
    WRONG_MODEL_SIZE,
    UNSUPPORTED_ABI,
    MISSING_LICENSE_REVIEW,
}

internal data class SpeakerDiarizationGateDecision(
    val status: SpeakerDiarizationGateStatus,
    val reason: String,
) {
    val isAvailable: Boolean
        get() = status == SpeakerDiarizationGateStatus.AVAILABLE
}

/**
 * Fail-closed registry for the one Sherpa-compatible model pair considered by S3.
 *
 * The model files intentionally are not packaged until their identities, licenses,
 * and both device probes have been admitted in speaker_diarization_manifest.json.
 */
internal class SpeakerDiarizationModelRegistry(
    private val context: Context,
    private val supportedAbis: Array<String> = Build.SUPPORTED_ABIS,
    val segmentation: SpeakerModelIdentity = candidateSegmentation,
    val embedding: SpeakerModelIdentity = candidateEmbedding,
    private val probesAdmitted: Boolean = false,
) {
    fun evaluate(): SpeakerDiarizationGateDecision {
        val staticDecision = evaluateStaticPrerequisites()
        if (staticDecision != null) return staticDecision
        if (!probesAdmitted) {
            return SpeakerDiarizationGateDecision(
                SpeakerDiarizationGateStatus.DEFERRED_FUNCTIONAL_GATE,
                "真机功能与资源门禁失败，候选模型不得进入产品",
            )
        }
        return evaluateCandidateArtifacts()
    }

    /**
     * Validates the candidate pair for an explicit admission probe without
     * claiming that the product capability itself is available.
     */
    fun evaluateCandidateArtifacts(): SpeakerDiarizationGateDecision {
        val staticDecision = evaluateStaticPrerequisites()
        if (staticDecision != null) return staticDecision
        for (model in listOf(segmentation, embedding)) {
            val artifact = readIdentity(model) ?: return SpeakerDiarizationGateDecision(
                SpeakerDiarizationGateStatus.MISSING_MODEL,
                "缺少候选模型工件 ${model.assetPath}",
            )
            if (artifact.bytes != model.expectedBytes) {
                return SpeakerDiarizationGateDecision(
                    SpeakerDiarizationGateStatus.WRONG_MODEL_SIZE,
                    "${model.id} 模型大小与准入记录不一致",
                )
            }
            if (!artifact.sha256.equals(model.expectedSha256, ignoreCase = true)) {
                return SpeakerDiarizationGateDecision(
                    SpeakerDiarizationGateStatus.WRONG_MODEL_HASH,
                    "${model.id} 模型哈希与准入记录不一致",
                )
            }
        }
        return SpeakerDiarizationGateDecision(
            SpeakerDiarizationGateStatus.AVAILABLE,
            "候选模型、许可、ABI 和工件身份可用于受控真机准入探针",
        )
    }

    private fun evaluateStaticPrerequisites(): SpeakerDiarizationGateDecision? {
        if (supportedAbis.none(SUPPORTED_ABIS::contains)) {
            return SpeakerDiarizationGateDecision(
                SpeakerDiarizationGateStatus.UNSUPPORTED_ABI,
                "当前 ABI 不在已检查的 Sherpa AAR ABI 集合中",
            )
        }
        for (model in listOf(segmentation, embedding)) {
            if (!model.distributionReviewed) {
                return SpeakerDiarizationGateDecision(
                    SpeakerDiarizationGateStatus.MISSING_LICENSE_REVIEW,
                    "${model.id} 尚未完成模型级分发许可复核",
                )
            }
            val expectedHash = model.expectedSha256
            val expectedBytes = model.expectedBytes
            if (expectedHash.isNullOrBlank() || expectedBytes == null) {
                return SpeakerDiarizationGateDecision(
                    SpeakerDiarizationGateStatus.DEFERRED_MODEL_AND_FIXTURE_GATE,
                    "${model.id} 尚未固定下载工件的 SHA-256 与大小",
                )
            }
        }
        return null
    }

    private fun readIdentity(model: SpeakerModelIdentity): SpeakerArtifactIdentity? =
        runCatching {
            val input =
                when (model.storage) {
                    SpeakerModelStorage.FLUTTER_ASSET ->
                        context.assets.open(model.assetPath)
                    SpeakerModelStorage.FILE_SYSTEM ->
                        File(model.assetPath).inputStream()
                }
            input.use {
                val digest = MessageDigest.getInstance("SHA-256")
                val buffer = ByteArray(64 * 1024)
                var totalBytes = 0L
                while (true) {
                    val count = it.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                    totalBytes += count
                }
                SpeakerArtifactIdentity(
                    bytes = totalBytes,
                    sha256 = digest.digest().joinToString("") { byte -> "%02x".format(byte) },
                )
            }
        }.getOrNull()

    companion object {
        const val AAR_VERSION = "1.13.3"
        const val AAR_SHA256 =
            "243ad797a3b6e75ebbeaf7a2ab4aec0777e7d71b730685abb762a120940b07b6"
        const val AAR_BYTES = 57_044_841L

        val SUPPORTED_ABIS = setOf("arm64-v8a", "armeabi-v7a", "x86", "x86_64")

        val candidateSegmentation = SpeakerModelIdentity(
            id = "sherpa-onnx-pyannote-segmentation-3-0",
            assetPath =
                "flutter_assets/assets/sherpa/speakers/" +
                    "pyannote-segmentation-3-0/model.onnx",
            sourceUrl =
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/" +
                    "speaker-segmentation-models/" +
                    "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
            sourceVersion = "speaker-segmentation-models@2024-10-08",
            expectedSha256 =
                "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
            expectedBytes = 5_992_913L,
            licenseId = "MIT",
            licenseSourceUrl =
                "https://huggingface.co/pyannote/segmentation-3.0/blob/main/LICENSE",
            distributionReviewed = true,
        )

        val candidateEmbedding = SpeakerModelIdentity(
            id = "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k",
            assetPath =
                "flutter_assets/assets/sherpa/speakers/" +
                    "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
            sourceUrl =
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/" +
                    "speaker-recongition-models/" +
                    "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
            sourceVersion = "speaker-recongition-models@2024-10-14",
            expectedSha256 =
                "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b",
            expectedBytes = 39_593_761L,
            licenseId = "Apache-2.0",
            licenseSourceUrl =
                "https://modelscope.cn/models/iic/" +
                    "speech_eres2net_base_sv_zh-cn_3dspeaker_16k/summary",
            distributionReviewed = true,
        )
    }

    private data class SpeakerArtifactIdentity(
        val bytes: Long,
        val sha256: String,
    )
}
