package com.voice2text.app

import android.content.Intent
import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ResultReceiver
import com.voice2text.app.build.BuildInfoProvider
import com.voice2text.app.companion.CompanionPlatformPlugin
import com.voice2text.app.contracts.AudioContract
import com.voice2text.app.importing.DocumentImportCoordinator
import com.voice2text.app.importing.ImportedMediaException
import com.voice2text.app.importing.SharedMediaRequestQueue
import com.voice2text.app.privacy.PrivacySafeLog
import com.voice2text.app.privacy.AudioApiSecretStore
import com.voice2text.app.privacy.AudioApiSecretUnavailableException
import com.voice2text.app.recording.RecordingForegroundService
import com.voice2text.app.recording.RecordingInputDeviceCatalog
import com.voice2text.app.recording.RecordingRecoveryManager
import com.voice2text.app.recording.RecordingSessionException
import com.voice2text.app.sharing.EphemeralShareCoordinator
import com.voice2text.app.sharing.EphemeralShareException
import com.voice2text.app.sharing.AudioShareCoordinator
import com.voice2text.app.sharing.AudioShareException
import com.voice2text.app.transcription.TranscriptionRequest
import com.voice2text.app.transcription.TranscriptionEventStream
import com.voice2text.app.transcription.TranscriptionExecutor
import com.voice2text.app.transcription.TranscriptionProgressEvent
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.EventChannel
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : FlutterActivity() {
    private val tag = "Voice2TextNative"
    private val channelName = AudioContract.RECORDER_CHANNEL

    private val recoveryManager by lazy { RecordingRecoveryManager(this) }
    private val buildInfoProvider by lazy { BuildInfoProvider(this) }
    private val transcriptionExecutor by lazy { TranscriptionExecutor.getInstance(this) }
    private val transcriptionEventStream by lazy { TranscriptionEventStream() }
    private val transcriptionEventListener: (TranscriptionProgressEvent) -> Unit = {
        transcriptionEventStream.emit(it)
    }
    private val importCoordinator by lazy { DocumentImportCoordinator(this) }
    private val shareCoordinator by lazy { AudioShareCoordinator(this) }
    private val ephemeralShareCoordinator by lazy { EphemeralShareCoordinator(this) }
    private val inputDeviceCatalog by lazy { RecordingInputDeviceCatalog(this) }
    private val audioApiSecretStore by lazy { AudioApiSecretStore(this) }
    private val sharedMediaRequests = SharedMediaRequestQueue()
    private val importExecutor = Executors.newSingleThreadExecutor()
    private val importActive = AtomicBoolean(false)
    private var pendingImportResult: MethodChannel.Result? = null
    private var methodChannel: MethodChannel? = null
    private var companionPlatformPlugin: CompanionPlatformPlugin? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        captureSharedIntent(intent)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        companionPlatformPlugin =
            CompanionPlatformPlugin(
                this,
                flutterEngine.dartExecutor.binaryMessenger,
            )
        EventChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            AudioContract.TRANSCRIPTION_EVENT_CHANNEL,
        ).setStreamHandler(transcriptionEventStream)
        transcriptionExecutor.setEventListener(transcriptionEventListener)
        importExecutor.execute {
            val removed = runCatching { importCoordinator.cleanupStaging() }.getOrDefault(0)
            if (removed > 0) {
                PrivacySafeLog.info(
                    tag,
                    "import_staging_reconciled",
                    mapOf("count" to removed),
                )
            }
            val removedShares =
                runCatching { ephemeralShareCoordinator.cleanupStale() }.getOrDefault(0)
            if (removedShares > 0) {
                PrivacySafeLog.info(
                    tag,
                    "ephemeral_share_cache_reconciled",
                    mapOf("count" to removedShares),
                )
            }
        }

        methodChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
        methodChannel
            ?.setMethodCallHandler { call: MethodCall, result: MethodChannel.Result ->
                when (call.method) {
                    "start" -> handleRecordingCommand(
                        action = RecordingForegroundService.ACTION_START,
                        result = result,
                        sessionId = call.argument<String>("sessionId"),
                        requireForegroundStart = true,
                    )
                    "pause" -> handleRecordingCommand(
                        action = RecordingForegroundService.ACTION_PAUSE,
                        result = result,
                    )
                    "resume" -> handleRecordingCommand(
                        action = RecordingForegroundService.ACTION_RESUME,
                        result = result,
                    )
                    "stop" -> handleRecordingCommand(
                        action = RecordingForegroundService.ACTION_STOP,
                        result = result,
                        stopReason = call.argument<String>("reason") ?: "user_stop",
                    )
                    "getRecordingState" -> handleGetRecordingState(result)
                    "listRecordingInputDevices" -> handleListRecordingInputDevices(result)
                    "selectRecordingInputDevice" -> handleSelectRecordingInputDevice(call, result)
                    "listRecordingRecoveries" -> handleListRecordingRecoveries(result)
                    "recoverRecording" -> handleRecoverRecording(call, result)
                    "discardRecordingRecovery" -> handleDiscardRecording(call, result)
                    "pickAudioMedia" -> handlePickAudioMedia(result)
                    "hasPendingSharedAudioMedia" ->
                        result.success(canConsumeSharedMedia())
                    "consumeSharedAudioMedia" -> handleConsumeSharedAudioMedia(result)
                    "cancelAudioImport" -> handleCancelAudioImport(result)
                    "discardImportedMedia" -> handleDiscardImportedMedia(call, result)
                    "shareAudioFile" -> handleShareAudioFile(call, result)
                    "discardShareExport" -> handleDiscardShareExport(call, result)
                    "shareEphemeralArtifact" -> handleShareEphemeralArtifact(call, result)
                    "discardEphemeralArtifact" -> handleDiscardEphemeralArtifact(call, result)
                    "getDeviceProtection" -> handleGetDeviceProtection(result)
                    "getBuildInfo" -> handleGetBuildInfo(result)
                    "setAudioApiSecret" -> handleSetAudioApiSecret(call, result)
                    "getAudioApiSecret" -> handleGetAudioApiSecret(call, result)
                    "hasAudioApiSecret" -> handleHasAudioApiSecret(call, result)
                    "deleteAudioApiSecret" -> handleDeleteAudioApiSecret(call, result)
                    "transcribe" -> handleTranscribe(call, result)
                    "cancelTranscriptionJob" -> handleCancelTranscriptionJob(call, result)
                    "getActiveTranscriptionJobIds" ->
                        result.success(transcriptionExecutor.activeJobIds())
                    else -> result.notImplemented()
                }
            }
        notifySharedMediaAvailable()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (captureSharedIntent(intent)) {
            notifySharedMediaAvailable()
        }
    }

    @Deprecated("Activity result API is retained for the Flutter activity picker bridge")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_IMPORT_MEDIA) {
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        val pending = pendingImportResult ?: return
        pendingImportResult = null
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) {
            pending.success(null)
            notifySharedMediaAvailable()
            return
        }
        if (!importActive.compareAndSet(false, true)) {
            pending.error("IMPORT_ALREADY_ACTIVE", "已有导入任务正在处理", null)
            return
        }
        executeMediaImport(uri, pending, "picker", "导入媒体失败")
    }

    override fun onDestroy() {
        companionPlatformPlugin?.dispose()
        companionPlatformPlugin = null
        pendingImportResult = null
        methodChannel = null
        importExecutor.shutdownNow()
        transcriptionExecutor.clearEventListener(transcriptionEventListener)
        super.onDestroy()
    }

    private fun handleRecordingCommand(
        action: String,
        result: MethodChannel.Result,
        sessionId: String? = null,
        stopReason: String? = null,
        inputDeviceId: Int? = null,
        requireForegroundStart: Boolean = false,
    ) {
        val receiver = object : ResultReceiver(Handler(Looper.getMainLooper())) {
            override fun onReceiveResult(resultCode: Int, resultData: Bundle?) {
                if (resultCode == RecordingForegroundService.RESULT_OK) {
                    result.success(resultData?.toPlainMap() ?: emptyMap<String, Any?>())
                    return
                }
                result.error(
                    resultData?.getString("code") ?: "RECORDING_FAILED",
                    resultData?.getString("message") ?: "录音操作失败",
                    null,
                )
            }
        }
        val intent = Intent(this, RecordingForegroundService::class.java).apply {
            this.action = action
            putExtra(RecordingForegroundService.EXTRA_RESULT_RECEIVER, receiver)
            sessionId?.let { putExtra(RecordingForegroundService.EXTRA_SESSION_ID, it) }
            stopReason?.let { putExtra(RecordingForegroundService.EXTRA_STOP_REASON, it) }
            inputDeviceId?.let {
                putExtra(RecordingForegroundService.EXTRA_INPUT_DEVICE_ID, it)
            }
        }
        try {
            if (requireForegroundStart) {
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    startForegroundService(intent)
                } else {
                    startService(intent)
                }
            } else {
                startService(intent)
            }
        } catch (e: Exception) {
            PrivacySafeLog.error(
                tag,
                "recording_command_failed",
                mapOf("category" to e.javaClass.simpleName),
            )
            result.error("SERVICE_START_FAILED", "无法启动录音服务", null)
        }
    }

    private fun handleGetRecordingState(result: MethodChannel.Result) {
        val active = RecordingForegroundService.currentSnapshot()
        if (active != null) {
            result.success(active)
            return
        }
        val latestRecovery = recoveryManager.scan().maxByOrNull { it.createdAtMs }
        val latestCompleted = recoveryManager.latestCompleted()
        val latest =
            listOfNotNull(latestRecovery, latestCompleted)
                .maxByOrNull { it.createdAtMs }
        result.success(latest?.toMap() ?: mapOf("state" to "idle"))
    }

    private fun handleListRecordingInputDevices(result: MethodChannel.Result) {
        try {
            result.success(inputDeviceCatalog.list().map { it.toMap() })
        } catch (error: Exception) {
            PrivacySafeLog.error(
                tag,
                "input_device_scan_failed",
                mapOf("category" to error.javaClass.simpleName),
            )
            result.error("INPUT_DEVICE_SCAN_FAILED", "无法读取录音输入设备", null)
        }
    }

    private fun handleSelectRecordingInputDevice(
        call: MethodCall,
        result: MethodChannel.Result,
    ) {
        val deviceId = call.argument<Int>("deviceId")
        try {
            deviceId?.let(inputDeviceCatalog::requireSelectable)
            if (RecordingForegroundService.hasActiveSession()) {
                handleRecordingCommand(
                    action = RecordingForegroundService.ACTION_SELECT_INPUT,
                    result = result,
                    inputDeviceId = deviceId,
                )
                return
            }
            RecordingForegroundService.setPendingInputSelection(deviceId)
            result.success(
                mapOf(
                    "state" to "idle",
                    "durationMs" to 0,
                    "preferredInputDeviceId" to deviceId,
                    "inputFallbackReason" to null,
                    "inputSelectionSupported" to
                        (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M),
                ),
            )
        } catch (error: RecordingSessionException) {
            result.error(error.code, error.message, null)
        } catch (error: Exception) {
            PrivacySafeLog.error(
                tag,
                "input_device_selection_failed",
                mapOf("category" to error.javaClass.simpleName),
            )
            result.error("INPUT_SELECTION_FAILED", "无法切换录音输入设备", null)
        }
    }

    private fun handleListRecordingRecoveries(result: MethodChannel.Result) {
        try {
            val activeSessionId =
                RecordingForegroundService.currentSnapshot()
                    ?.takeIf {
                        it["state"] == "recording" || it["state"] == "paused"
                    }
                    ?.get("sessionId") as? String
            result.success(
                recoveryManager
                    .scan()
                    .filterNot { it.sessionId == activeSessionId }
                    .map { it.toMap() },
            )
        } catch (e: Exception) {
            PrivacySafeLog.error(
                tag,
                "recovery_scan_failed",
                mapOf("category" to e.javaClass.simpleName),
            )
            result.error("RECOVERY_SCAN_FAILED", "无法检查待恢复录音", null)
        }
    }

    private fun handleRecoverRecording(call: MethodCall, result: MethodChannel.Result) {
        val sessionId = call.argument<String>("sessionId").orEmpty()
        try {
            val recovered = recoveryManager.recover(sessionId)
            result.success(
                mapOf(
                    "sessionId" to recovered.sessionId,
                    "path" to recovered.path,
                    "canonicalPath" to recovered.path,
                    "stagingPath" to "",
                    "durationMs" to recovered.durationMs,
                    "state" to recovered.state,
                    "stopReason" to recovered.stopReason,
                ),
            )
        } catch (e: RecordingSessionException) {
            result.error(e.code, e.message, null)
        }
    }

    private fun handleDiscardRecording(call: MethodCall, result: MethodChannel.Result) {
        val sessionId = call.argument<String>("sessionId").orEmpty()
        try {
            val discarded = recoveryManager.discard(sessionId)
            if (discarded) {
                result.success(null)
            } else {
                result.error("DISCARD_FAILED", "临时录音文件无法清理", null)
            }
        } catch (e: Exception) {
            PrivacySafeLog.error(
                tag,
                "recovery_discard_failed",
                mapOf("category" to e.javaClass.simpleName),
            )
            result.error("DISCARD_FAILED", "临时录音文件无法清理", null)
        }
    }

    private fun handlePickAudioMedia(result: MethodChannel.Result) {
        if (pendingImportResult != null || importActive.get()) {
            result.error("IMPORT_ALREADY_ACTIVE", "已有导入任务正在等待选择", null)
            return
        }
        pendingImportResult = result
        importCoordinator.prepareImportRequest()
        try {
            startActivityForResult(importCoordinator.pickerIntent(), REQUEST_IMPORT_MEDIA)
        } catch (error: Exception) {
            pendingImportResult = null
            PrivacySafeLog.error(
                tag,
                "media_picker_failed",
                mapOf("category" to error.javaClass.simpleName),
            )
            result.error("PICKER_UNAVAILABLE", "系统文件选择器不可用", null)
            notifySharedMediaAvailable()
        }
    }

    private fun handleConsumeSharedAudioMedia(result: MethodChannel.Result) {
        if (pendingImportResult != null || !importActive.compareAndSet(false, true)) {
            result.success(null)
            return
        }
        val uriString = sharedMediaRequests.poll()
        if (uriString == null) {
            importActive.set(false)
            result.success(null)
            return
        }
        importCoordinator.prepareImportRequest()
        executeMediaImport(Uri.parse(uriString), result, "shared", "导入分享媒体失败")
    }

    private fun handleCancelAudioImport(result: MethodChannel.Result) {
        importCoordinator.cancelActiveImport()
        result.success(null)
    }

    private fun handleDiscardImportedMedia(call: MethodCall, result: MethodChannel.Result) {
        val path = call.argument<String>("path").orEmpty()
        if (importCoordinator.discard(path)) {
            result.success(null)
        } else {
            result.error("IMPORT_DISCARD_FAILED", "无法清理导入文件", null)
        }
    }

    private fun handleDiscardShareExport(call: MethodCall, result: MethodChannel.Result) {
        val path = call.argument<String>("path").orEmpty()
        if (shareCoordinator.discardExport(path)) {
            result.success(null)
        } else {
            result.error("SHARE_DISCARD_FAILED", "无法清理分享临时文件", null)
        }
    }

    private fun handleShareAudioFile(call: MethodCall, result: MethodChannel.Result) {
        val path = call.argument<String>("path").orEmpty()
        val displayName = call.argument<String>("displayName")
        try {
            result.success(
                mapOf(
                    "exportPath" to shareCoordinator.share(path, displayName),
                    "readOnly" to true,
                ),
            )
        } catch (error: AudioShareException) {
            result.error(error.code, error.message, null)
        } catch (error: Exception) {
            PrivacySafeLog.error(
                tag,
                "audio_share_failed",
                mapOf("category" to error.javaClass.simpleName),
            )
            result.error("SHARE_FAILED", "无法打开系统分享", null)
        }
    }

    private fun handleShareEphemeralArtifact(call: MethodCall, result: MethodChannel.Result) {
        val path = call.argument<String>("path").orEmpty()
        val displayName = call.argument<String>("displayName")
        try {
            result.success(
                mapOf(
                    "path" to ephemeralShareCoordinator.share(path, displayName),
                    "readOnly" to true,
                ),
            )
        } catch (error: EphemeralShareException) {
            result.error(error.code, error.message, null)
        } catch (error: Exception) {
            PrivacySafeLog.error(
                tag,
                "ephemeral_share_failed",
                mapOf("category" to error.javaClass.simpleName),
            )
            result.error("EPHEMERAL_SHARE_FAILED", "无法打开系统分享", null)
        }
    }

    private fun handleDiscardEphemeralArtifact(call: MethodCall, result: MethodChannel.Result) {
        val path = call.argument<String>("path").orEmpty()
        if (ephemeralShareCoordinator.discard(path)) {
            result.success(null)
        } else {
            result.error("EPHEMERAL_DISCARD_FAILED", "无法清理临时分享文件", null)
        }
    }

    private fun handleTranscribe(call: MethodCall, result: MethodChannel.Result) {
        val recordingPath = call.argument<String>("recordingPath") ?: ""
        val durationMs = call.argument<Int>("durationMs") ?: 0
        val modelId = call.argument<String>("modelId") ?: "paraformer-zh"
        val jobId =
            call.argument<Int>("jobId")
                ?.takeIf { it != 0 }
                ?: TranscriptionExecutor.nextLegacyJobId()
        val sampleRateHz = call.argument<Int>("sampleRateHz") ?: 16000
        val enablePunctuation = call.argument<Boolean>("enablePunctuation") ?: true
        val enableDenoise = call.argument<Boolean>("enableDenoise") ?: false
        val attemptCount = call.argument<Int>("attemptCount") ?: 1
        val started = System.currentTimeMillis()
        val request = TranscriptionRequest(
            recordingPath = recordingPath,
            durationMs = durationMs,
            modelId = modelId,
            sampleRateHz = sampleRateHz,
            enablePunctuation = enablePunctuation,
            enableDenoise = enableDenoise,
            attemptCount = attemptCount,
        )
        transcriptionExecutor.submit(jobId, request) { outcome ->
            runOnUiThread {
                if (outcome.successful) {
                    PrivacySafeLog.info(
                        tag,
                        "transcribe_completed",
                        mapOf(
                            "jobId" to jobId,
                            "model" to modelId,
                            "durationMs" to durationMs,
                            "costMs" to (System.currentTimeMillis() - started),
                        ),
                    )
                    result.success(outcome.result?.toMap())
                } else {
                    PrivacySafeLog.error(
                        tag,
                        "transcribe_failed",
                        mapOf(
                            "jobId" to jobId,
                            "model" to modelId,
                            "stage" to outcome.errorStage,
                            "category" to outcome.errorCode,
                        ),
                    )
                    result.error(
                        outcome.errorCode ?: "TRANSCRIBE_FAILED",
                        outcome.errorMessage ?: "转写失败",
                        mapOf("stage" to (outcome.errorStage ?: "unknown")),
                    )
                }
            }
        }
    }

    private fun handleCancelTranscriptionJob(call: MethodCall, result: MethodChannel.Result) {
        val jobId = call.argument<Int>("jobId") ?: 0
        if (jobId == 0) {
            result.error("INVALID_JOB_ID", "任务 ID 无效", mapOf("stage" to "cancellation"))
            return
        }
        transcriptionExecutor.cancel(jobId)
        result.success(null)
    }

    private fun handleGetBuildInfo(result: MethodChannel.Result) {
        try {
            result.success(buildInfoProvider.getBuildInfo())
        } catch (e: Exception) {
            result.error("BUILD_INFO_FAILED", e.message ?: "读取构建信息失败", null)
        }
    }

    private fun handleSetAudioApiSecret(
        call: MethodCall,
        result: MethodChannel.Result,
    ) {
        val providerId = call.argument<String>("providerId").orEmpty()
        val secret = call.argument<String>("secret").orEmpty()
        try {
            audioApiSecretStore.set(providerId, secret)
            result.success(null)
        } catch (_: IllegalArgumentException) {
            result.error("INVALID_MEETING_API_SECRET", "密钥格式无效", null)
        } catch (_: Exception) {
            PrivacySafeLog.error(tag, "audio_api_secret_write_failed")
            result.error("MEETING_API_SECRET_WRITE_FAILED", "密钥无法安全保存", null)
        }
    }

    private fun handleGetAudioApiSecret(
        call: MethodCall,
        result: MethodChannel.Result,
    ) {
        val providerId = call.argument<String>("providerId").orEmpty()
        try {
            result.success(audioApiSecretStore.get(providerId))
        } catch (_: AudioApiSecretUnavailableException) {
            result.error("MEETING_API_SECRET_UNAVAILABLE", "密钥已失效，请重新输入", null)
        } catch (_: IllegalArgumentException) {
            result.error("INVALID_MEETING_API_PROVIDER", "提供商标识无效", null)
        } catch (_: Exception) {
            PrivacySafeLog.error(tag, "audio_api_secret_read_failed")
            result.error("MEETING_API_SECRET_READ_FAILED", "密钥无法读取", null)
        }
    }

    private fun handleHasAudioApiSecret(
        call: MethodCall,
        result: MethodChannel.Result,
    ) {
        val providerId = call.argument<String>("providerId").orEmpty()
        try {
            result.success(audioApiSecretStore.has(providerId))
        } catch (_: IllegalArgumentException) {
            result.error("INVALID_MEETING_API_PROVIDER", "提供商标识无效", null)
        } catch (_: Exception) {
            result.success(false)
        }
    }

    private fun handleDeleteAudioApiSecret(
        call: MethodCall,
        result: MethodChannel.Result,
    ) {
        val providerId = call.argument<String>("providerId").orEmpty()
        try {
            audioApiSecretStore.delete(providerId)
            result.success(null)
        } catch (_: IllegalArgumentException) {
            result.error("INVALID_MEETING_API_PROVIDER", "提供商标识无效", null)
        } catch (_: Exception) {
            PrivacySafeLog.error(tag, "audio_api_secret_delete_failed")
            result.error("MEETING_API_SECRET_DELETE_FAILED", "密钥无法删除", null)
        }
    }

    private fun handleGetDeviceProtection(result: MethodChannel.Result) {
        result.success(
            mapOf(
                "storageScope" to "app_private_internal",
                "protectionCategory" to "device_security_managed",
                "protectionSummary" to "由设备安全设置保护",
                "applicationLayerEncryption" to false,
                "platformEncryptionStatus" to "not_exposed",
                "backupPolicy" to "app_data_excluded",
                "stableDeviceIdentifierIncluded" to false,
            ),
        )
    }

    @Suppress("DEPRECATION")
    private fun captureSharedIntent(intent: Intent?): Boolean {
        if (intent?.action != Intent.ACTION_SEND) return false
        val mimeType = intent.type?.lowercase().orEmpty()
        if (!mimeType.startsWith("audio/") && !mimeType.startsWith("video/")) {
            return false
        }
        val uri =
            intent.getParcelableExtra<android.os.Parcelable>(Intent.EXTRA_STREAM) as? Uri
                ?: intent.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.uri
                ?: return false
        if (uri.scheme != "content" && uri.scheme != "file") return false
        return sharedMediaRequests.offer(uri.toString())
    }

    private fun executeMediaImport(
        uri: Uri,
        result: MethodChannel.Result,
        source: String,
        fallbackMessage: String,
    ) {
        importExecutor.execute {
            try {
                val imported = importCoordinator.import(uri)
                runOnUiThread { result.success(imported.toMap()) }
            } catch (error: ImportedMediaException) {
                runOnUiThread { result.error(error.code, error.message, null) }
            } catch (error: Exception) {
                PrivacySafeLog.error(
                    tag,
                    "${source}_media_import_failed",
                    mapOf("category" to error.javaClass.simpleName),
                )
                runOnUiThread { result.error("IMPORT_FAILED", fallbackMessage, null) }
            } finally {
                finishImport()
            }
        }
    }

    private fun canConsumeSharedMedia(): Boolean =
        sharedMediaRequests.hasPending() &&
            pendingImportResult == null &&
            !importActive.get()

    private fun finishImport() {
        importActive.set(false)
        if (sharedMediaRequests.hasPending()) {
            runOnUiThread(::notifySharedMediaAvailable)
        }
    }

    private fun notifySharedMediaAvailable() {
        if (!canConsumeSharedMedia()) return
        methodChannel?.invokeMethod("sharedAudioMediaAvailable", null)
    }

    companion object {
        private const val REQUEST_IMPORT_MEDIA = 4701
    }
}

private fun Bundle.toPlainMap(): Map<String, Any?> =
    keySet().associateWith { key -> get(key) }
