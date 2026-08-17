package com.voice2text.app.recording

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

data class RecordingInputDeviceDescriptor(
    val id: Int,
    val name: String,
    val deviceType: String,
    val canSelect: Boolean,
) {
    fun toMap(): Map<String, Any?> =
        mapOf(
            "id" to id,
            "name" to name,
            "inputDeviceType" to deviceType,
            "canSelect" to canSelect,
        )
}

class RecordingInputDeviceCatalog(context: Context) {
    private val audioManager =
        context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    fun list(): List<RecordingInputDeviceDescriptor> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return emptyList()
        return audioManager
            .getDevices(AudioManager.GET_DEVICES_INPUTS)
            .filter(AudioDeviceInfo::isSource)
            .map(AudioDeviceInfo::toRecordingInputDeviceDescriptor)
            .sortedWith(
                compareBy<RecordingInputDeviceDescriptor>(
                    { it.deviceType == RecordingInputDeviceTypes.BUILT_IN },
                    { it.name.lowercase() },
                    { it.id },
                ),
            )
    }

    fun requireSelectable(deviceId: Int): AudioDeviceInfo {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            throw RecordingSessionException(
                "INPUT_SELECTION_UNSUPPORTED",
                "当前 Android 版本仅支持系统自动选择录音输入",
            )
        }
        return find(deviceId)
            ?: throw RecordingSessionException(
                "INPUT_DEVICE_UNAVAILABLE",
                "所选麦克风已断开，请重新选择",
            )
    }

    fun find(deviceId: Int): AudioDeviceInfo? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
        return audioManager
            .getDevices(AudioManager.GET_DEVICES_INPUTS)
            .firstOrNull { it.id == deviceId && it.isSource }
    }
}

internal fun AudioDeviceInfo.toRecordingInputDeviceDescriptor(): RecordingInputDeviceDescriptor =
    RecordingInputDeviceDescriptor(
        id = id,
        name = productName.toString().trim().ifEmpty { recordingInputDeviceFallbackName() },
        deviceType = recordingInputDeviceType(),
        canSelect = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M,
    )

internal fun AudioDeviceInfo.recordingInputDeviceType(): String =
    when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> RecordingInputDeviceTypes.BUILT_IN
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> RecordingInputDeviceTypes.WIRED
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> RecordingInputDeviceTypes.BLUETOOTH
        AudioDeviceInfo.TYPE_USB_DEVICE,
        AudioDeviceInfo.TYPE_USB_ACCESSORY,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        -> RecordingInputDeviceTypes.USB
        AudioDeviceInfo.TYPE_LINE_ANALOG,
        AudioDeviceInfo.TYPE_LINE_DIGITAL,
        AudioDeviceInfo.TYPE_BUS,
        -> RecordingInputDeviceTypes.EXTERNAL
        else -> RecordingInputDeviceTypes.EXTERNAL
    }

private fun AudioDeviceInfo.recordingInputDeviceFallbackName(): String =
    when (recordingInputDeviceType()) {
        RecordingInputDeviceTypes.BUILT_IN -> "内置麦克风"
        RecordingInputDeviceTypes.WIRED -> "有线麦克风"
        RecordingInputDeviceTypes.BLUETOOTH -> "蓝牙麦克风"
        RecordingInputDeviceTypes.USB -> "USB 麦克风"
        else -> "外部麦克风"
    }
