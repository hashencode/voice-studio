package com.voice2text.app.recording

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.ResultReceiver
import com.voice2text.app.MainActivity
import com.voice2text.app.contracts.AudioContract

class RecordingForegroundService : Service(), AudioManager.OnAudioFocusChangeListener {
    private lateinit var session: StandardRecordingSession
    private lateinit var audioManager: AudioManager
    private val handler = Handler(Looper.getMainLooper())
    private var audioFocusRequest: AudioFocusRequest? = null
    private var normalShutdown = false
    private var inputRouteNotice: String? = null
    private val audioDeviceCallback =
        object : AudioDeviceCallback() {
            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
                handleInputDevicesRemoved(removedDevices.map { it.id }.toSet())
            }
        }

    override fun onCreate() {
        super.onCreate()
        session = StandardRecordingSession(this)
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            audioManager.registerAudioDeviceCallback(audioDeviceCallback, handler)
        }
        instance = this
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: return START_NOT_STICKY
        val receiver = intent.resultReceiver()
        when (action) {
            ACTION_START -> handleStart(intent.getStringExtra(EXTRA_SESSION_ID), receiver)
            ACTION_PAUSE -> handlePause(receiver)
            ACTION_RESUME -> handleResume(receiver)
            ACTION_STOP -> handleStop(intent.getStringExtra(EXTRA_STOP_REASON) ?: "user_stop", receiver)
            ACTION_SELECT_INPUT -> {
                val deviceId =
                    if (intent.hasExtra(EXTRA_INPUT_DEVICE_ID)) {
                        intent.getIntExtra(EXTRA_INPUT_DEVICE_ID, 0)
                    } else {
                        null
                    }
                handleSelectInput(deviceId, receiver)
            }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        handler.removeCallbacks(storageCheck)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            audioManager.unregisterAudioDeviceCallback(audioDeviceCallback)
        }
        abandonAudioFocus()
        if (!normalShutdown && session.snapshot()?.state in ACTIVE_STATES) {
            runCatching { session.stop("service_terminated") }
                .onSuccess { latestSnapshot = it.toMap() }
                .onFailure { latestSnapshot = session.snapshot()?.toMap() }
        }
        instance = null
        super.onDestroy()
    }

    override fun onAudioFocusChange(focusChange: Int) {
        if (focusChange == AudioManager.AUDIOFOCUS_LOSS ||
            focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ||
            focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
        ) {
            handleStop("audio_focus_loss", null)
        }
    }

    private fun handleStart(sessionId: String?, receiver: ResultReceiver?) {
        val current = session.snapshot()
        if (current?.state == RecordingStates.RECORDING || current?.state == RecordingStates.PAUSED) {
            ensureForeground(current)
            receiver.success(current.toMap() + session.telemetrySnapshot().toMap())
            return
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            receiver.error("PERMISSION_DENIED", "麦克风权限未开启")
            stopSelf()
            return
        }
        ensureForeground(null)
        try {
            if (!requestAudioFocus()) {
                throw RecordingSessionException(
                    "AUDIO_FOCUS_DENIED",
                    "其他应用正在独占音频输入，请稍后重试",
                )
            }
            val started = session.start(
                sessionId ?: java.util.UUID.randomUUID().toString(),
                pendingPreferredInputDeviceId,
            )
            val telemetry = session.telemetrySnapshot()
            if (telemetry.fallbackReason == RecordingInputFallbackReasons.DEVICE_DISCONNECTED) {
                pendingPreferredInputDeviceId = null
                inputRouteNotice = "所选麦克风已断开，已切换到系统默认输入"
            } else {
                inputRouteNotice = null
            }
            latestSnapshot = started.toMap() + telemetry.toMap()
            ensureForeground(started)
            scheduleStorageCheck()
            receiver.success(latestSnapshot.orEmpty())
        } catch (e: RecordingSessionException) {
            receiver.error(e.code, e.message)
            normalShutdown = true
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun handlePause(receiver: ResultReceiver?) {
        try {
            val paused = session.pause()
            latestSnapshot = paused.toMap()
            ensureForeground(paused)
            receiver.success(paused.toMap() + session.telemetrySnapshot().toMap())
        } catch (e: RecordingSessionException) {
            receiver.error(e.code, e.message)
        }
    }

    private fun handleResume(receiver: ResultReceiver?) {
        try {
            val resumed = session.resume()
            latestSnapshot = resumed.toMap()
            ensureForeground(resumed)
            receiver.success(resumed.toMap() + session.telemetrySnapshot().toMap())
        } catch (e: RecordingSessionException) {
            receiver.error(e.code, e.message)
        }
    }

    private fun handleSelectInput(deviceId: Int?, receiver: ResultReceiver?) {
        try {
            val telemetry = session.selectInputDevice(deviceId)
            pendingPreferredInputDeviceId = deviceId
            inputRouteNotice = null
            val current = session.snapshot()
                ?: throw RecordingSessionException("INVALID_STATE", "当前没有可切换输入的录音")
            val values = current.toMap() + telemetry.toMap()
            latestSnapshot = values
            ensureForeground(current)
            receiver.success(values)
        } catch (e: RecordingSessionException) {
            receiver.error(e.code, e.message)
        }
    }

    private fun handleInputDevicesRemoved(removedDeviceIds: Set<Int>) {
        when (session.handleInputDevicesRemoved(removedDeviceIds)) {
            RecordingInputDisconnectOutcome.UNCHANGED -> Unit
            RecordingInputDisconnectOutcome.FALLBACK_TO_AUTOMATIC -> {
                pendingPreferredInputDeviceId = null
                inputRouteNotice = "所选麦克风已断开，已切换到系统默认输入"
                session.snapshot()?.let { current ->
                    latestSnapshot = current.toMap() + session.telemetrySnapshot().toMap()
                    ensureForeground(current)
                }
            }
            RecordingInputDisconnectOutcome.STOP_REQUIRED -> {
                pendingPreferredInputDeviceId = null
                inputRouteNotice = "所选麦克风已断开，无法安全切换输入"
                handleStop("input_device_lost", null)
            }
        }
    }

    private fun handleStop(reason: String, receiver: ResultReceiver?) {
        handler.removeCallbacks(storageCheck)
        try {
            val result = session.stop(reason)
            latestSnapshot = result.toMap()
            receiver.success(result.toMap())
        } catch (e: RecordingSessionException) {
            latestSnapshot = session.snapshot()?.toMap()
            receiver.error(e.code, e.message)
        } finally {
            abandonAudioFocus()
            normalShutdown = true
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun scheduleStorageCheck() {
        handler.removeCallbacks(storageCheck)
        handler.postDelayed(storageCheck, AudioContract.STORAGE_CHECK_INTERVAL_MS)
    }

    private val storageCheck = object : Runnable {
        override fun run() {
            val state = session.snapshot()?.state
            if (state !in ACTIVE_STATES) return
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                handleStop("permission_revoked", null)
                return
            }
            if (!session.hasSafeStorageReserve()) {
                handleStop("low_storage", null)
                return
            }
            handler.postDelayed(this, AudioContract.STORAGE_CHECK_INTERVAL_MS)
        }
    }

    private fun ensureForeground(journal: RecordingJournal?) {
        val notification = buildNotification(journal)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                AudioContract.RECORDING_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } else {
            startForeground(AudioContract.RECORDING_NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(journal: RecordingJournal?): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, RecordingForegroundService::class.java).apply {
                action = ACTION_STOP
                putExtra(EXTRA_STOP_REASON, "notification_stop")
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val status = inputRouteNotice ?: when (journal?.state) {
            RecordingStates.PAUSED -> "录音已暂停，内容仅保存在本机"
            RecordingStates.RECORDING -> "正在录音，内容仅保存在本机"
            else -> "正在准备录音"
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, AudioContract.RECORDING_NOTIFICATION_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle("音频录音进行中")
            .setContentText(status)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(
                Notification.Action.Builder(
                    null,
                    "停止并保存",
                    stopIntent,
                ).build(),
            )
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                AudioContract.RECORDING_NOTIFICATION_CHANNEL_ID,
                "音频录音",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "持续显示音频录音状态和停止入口"
                setShowBadge(false)
            },
        )
    }

    private fun requestAudioFocus(): Boolean {
        val result =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val request =
                    AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                        .setAudioAttributes(
                            AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build(),
                        )
                        .setOnAudioFocusChangeListener(this)
                        .build()
                audioFocusRequest = request
                audioManager.requestAudioFocus(request)
            } else {
                @Suppress("DEPRECATION")
                audioManager.requestAudioFocus(
                    this,
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE,
                )
            }
        return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(this)
        }
        audioFocusRequest = null
    }

    companion object {
        const val ACTION_START = "com.voice2text.app.recording.START"
        const val ACTION_PAUSE = "com.voice2text.app.recording.PAUSE"
        const val ACTION_RESUME = "com.voice2text.app.recording.RESUME"
        const val ACTION_STOP = "com.voice2text.app.recording.STOP"
        const val ACTION_SELECT_INPUT = "com.voice2text.app.recording.SELECT_INPUT"
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_STOP_REASON = "stop_reason"
        const val EXTRA_INPUT_DEVICE_ID = "input_device_id"
        const val EXTRA_RESULT_RECEIVER = "result_receiver"

        const val RESULT_OK = 0
        const val RESULT_ERROR = 1

        @Volatile
        private var instance: RecordingForegroundService? = null

        @Volatile
        private var latestSnapshot: Map<String, Any?>? = null

        @Volatile
        private var pendingPreferredInputDeviceId: Int? = null

        private val ACTIVE_STATES = setOf(RecordingStates.RECORDING, RecordingStates.PAUSED)

        fun currentSnapshot(): Map<String, Any?>? {
            val activeSession = instance?.session ?: return latestSnapshot
            val snapshot = activeSession.snapshot() ?: return latestSnapshot
            return snapshot.toMap() + activeSession.telemetrySnapshot().toMap()
        }

        fun hasActiveSession(): Boolean =
            instance?.session?.snapshot()?.state in ACTIVE_STATES

        fun setPendingInputSelection(deviceId: Int?) {
            pendingPreferredInputDeviceId = deviceId
        }
    }
}

private fun RecordingSessionResult.toMap(): Map<String, Any?> = mapOf(
    "sessionId" to sessionId,
    "path" to path,
    "canonicalPath" to path,
    "stagingPath" to "",
    "durationMs" to durationMs,
    "state" to state,
    "stopReason" to stopReason,
    "errorCategory" to null,
    "updatedAtMs" to System.currentTimeMillis(),
)

private fun Intent.resultReceiver(): ResultReceiver? {
    @Suppress("DEPRECATION")
    return getParcelableExtra(RecordingForegroundService.EXTRA_RESULT_RECEIVER)
}

private fun ResultReceiver?.success(values: Map<String, Any?>) {
    this ?: return
    send(RecordingForegroundService.RESULT_OK, values.toBundle())
}

private fun ResultReceiver?.error(code: String, message: String) {
    this ?: return
    send(
        RecordingForegroundService.RESULT_ERROR,
        Bundle().apply {
            putString("code", code)
            putString("message", message)
        },
    )
}

private fun Map<String, Any?>.toBundle(): Bundle = Bundle().apply {
    forEach { (key, value) ->
        when (value) {
            is String -> putString(key, value)
            is Int -> putInt(key, value)
            is Long -> putLong(key, value)
            is Boolean -> putBoolean(key, value)
            is Double -> putDouble(key, value)
            null -> putString(key, null)
        }
    }
}
