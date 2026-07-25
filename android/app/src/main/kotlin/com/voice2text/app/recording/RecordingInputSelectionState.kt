package com.voice2text.app.recording

object RecordingInputFallbackReasons {
    const val DEVICE_DISCONNECTED = "device_disconnected"
}

class RecordingInputSelectionState {
    var preferredDeviceId: Int? = null
        private set

    var fallbackReason: String? = null
        private set

    fun select(deviceId: Int?) {
        preferredDeviceId = deviceId
        fallbackReason = null
    }

    fun markFallback(reason: String) {
        preferredDeviceId = null
        fallbackReason = reason
    }

    fun handleRemovedDevices(removedDeviceIds: Set<Int>): Boolean {
        val selected = preferredDeviceId ?: return false
        if (selected !in removedDeviceIds) return false
        markFallback(RecordingInputFallbackReasons.DEVICE_DISCONNECTED)
        return true
    }
}

enum class RecordingInputDisconnectOutcome {
    UNCHANGED,
    FALLBACK_TO_AUTOMATIC,
    STOP_REQUIRED,
}
