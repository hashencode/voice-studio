package com.voice2text.app.speakers

import android.content.Context
import java.io.File

/**
 * The single fallback admitted by the static candidate scorecard.
 *
 * It keeps the installed Sherpa runtime and licensed 3D-Speaker embedding model,
 * changing only Pyannote's official INT8 segmentation artifact.
 */
internal object SelectedFallbackSpeakerDiarizationCandidate {
    const val ID = "sherpa-v1.13.3-pyannote-int8-3dspeaker"
    const val SEGMENTATION_SHA256 =
        "d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d"
    const val SEGMENTATION_BYTES = 1_540_506L

    fun registry(
        context: Context,
        segmentationFile: File,
        embeddingFile: File,
    ): SpeakerDiarizationModelRegistry =
        SpeakerDiarizationModelRegistry(
            context = context,
            segmentation =
                SpeakerDiarizationModelRegistry.candidateSegmentation.copy(
                    id = "sherpa-onnx-pyannote-segmentation-3-0-int8",
                    assetPath = segmentationFile.absolutePath,
                    expectedSha256 = SEGMENTATION_SHA256,
                    expectedBytes = SEGMENTATION_BYTES,
                    storage = SpeakerModelStorage.FILE_SYSTEM,
                ),
            embedding =
                SpeakerDiarizationModelRegistry.candidateEmbedding.copy(
                    assetPath = embeddingFile.absolutePath,
                    storage = SpeakerModelStorage.FILE_SYSTEM,
                ),
        )
}
