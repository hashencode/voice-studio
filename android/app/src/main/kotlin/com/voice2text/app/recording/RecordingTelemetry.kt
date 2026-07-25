package com.voice2text.app.recording

object RecordingTelemetryStatuses {
    const val AVAILABLE = "available"
    const val SILENT = "silent"
    const val PAUSED = "paused"
    const val UNKNOWN = "unknown"
}

object RecordingInputDeviceTypes {
    const val BUILT_IN = "built_in"
    const val WIRED = "wired"
    const val BLUETOOTH = "bluetooth"
    const val USB = "usb"
    const val EXTERNAL = "external"
}

data class RawRecordingTelemetry(
    val amplitude: Int,
    val deviceType: String?,
    val deviceId: Int? = null,
    val deviceName: String? = null,
)

data class RecordingTelemetrySnapshot(
    val amplitude: Int,
    val status: String,
    val deviceType: String?,
    val isAvailable: Boolean,
    val deviceId: Int? = null,
    val deviceName: String? = null,
    val preferredDeviceId: Int? = null,
    val fallbackReason: String? = null,
    val selectionSupported: Boolean = false,
) {
    fun toMap(): Map<String, Any?> =
        mapOf(
            "inputAmplitude" to amplitude,
            "inputStatus" to status,
            "inputDeviceType" to deviceType,
            "inputAvailable" to isAvailable,
            "inputDeviceId" to deviceId,
            "inputDeviceName" to deviceName,
            "preferredInputDeviceId" to preferredDeviceId,
            "inputFallbackReason" to fallbackReason,
            "inputSelectionSupported" to selectionSupported,
        )
}

class RecordingTelemetrySampler(
    private val sampleProvider: () -> RawRecordingTelemetry,
) {
    fun snapshot(sessionState: String): RecordingTelemetrySnapshot {
        if (sessionState == RecordingStates.PAUSED) {
            return RecordingTelemetrySnapshot(
                amplitude = 0,
                status = RecordingTelemetryStatuses.PAUSED,
                deviceType = null,
                isAvailable = false,
            )
        }
        if (sessionState != RecordingStates.RECORDING) {
            return unknownSnapshot()
        }

        return runCatching {
            val sample = sampleProvider()
            val amplitude = sample.amplitude.coerceIn(0, MAX_AMPLITUDE)
            val deviceType = sample.deviceType
            if (deviceType == null) {
                return@runCatching unknownSnapshot(amplitude = amplitude)
            }
            RecordingTelemetrySnapshot(
                amplitude = amplitude,
                status =
                    if (amplitude == 0) {
                        RecordingTelemetryStatuses.SILENT
                    } else {
                        RecordingTelemetryStatuses.AVAILABLE
                    },
                deviceType = deviceType,
                isAvailable = true,
                deviceId = sample.deviceId,
                deviceName = sample.deviceName,
            )
        }.getOrElse { unknownSnapshot() }
    }

    private fun unknownSnapshot(amplitude: Int = 0): RecordingTelemetrySnapshot =
        RecordingTelemetrySnapshot(
            amplitude = amplitude,
            status = RecordingTelemetryStatuses.UNKNOWN,
            deviceType = null,
            isAvailable = false,
        )

    companion object {
        const val MAX_AMPLITUDE = 32_767
    }
}
