package com.voice2text.app.recording

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import com.voice2text.app.contracts.AudioContract
import java.io.File
import java.util.UUID

class StandardRecordingSession(
    private val context: Context,
    private val journalStore: RecordingJournalStore = RecordingJournalStore(context),
    private val storageGuard: RecordingStorageGuard = RecordingStorageGuard(context.filesDir),
    private val validator: RecordingAssetValidator = MediaRecordingAssetValidator(),
) {
    private var recorder: MediaRecorder? = null
    private var journal: RecordingJournal? = null
    private var telemetrySampler: RecordingTelemetrySampler? = null
    private val inputDeviceCatalog = RecordingInputDeviceCatalog(context)
    private val inputSelection = RecordingInputSelectionState()

    @Synchronized
    fun start(
        sessionId: String = UUID.randomUUID().toString(),
        preferredInputDeviceId: Int? = null,
    ): RecordingJournal {
        if (recorder != null || journal?.state in ACTIVE_STATES) {
            val current = journal
            if (current?.state == RecordingStates.RECORDING || current?.state == RecordingStates.PAUSED) {
                return current
            }
            throw RecordingSessionException("INVALID_STATE", "录音已在进行中")
        }
        storageGuard.requireCanStart()

        val now = System.currentTimeMillis()
        val staging = createStagingFile(sessionId)
        val canonical = createCanonicalFile(sessionId)
        var next = RecordingJournal(
            sessionId = sessionId,
            state = RecordingStates.PREPARING,
            stagingPath = staging.absolutePath,
            canonicalPath = canonical.absolutePath,
            accumulatedMs = 0L,
            activeSinceMs = null,
            createdAtMs = now,
            updatedAtMs = now,
            stopReason = null,
            errorCategory = null,
        )
        try {
            persist(next)
        } catch (_: Exception) {
            staging.delete()
            journal = null
            throw RecordingSessionException("JOURNAL_FAILED", "无法创建录音恢复日志")
        }

        try {
            var fellBackFromUnavailablePreferredInput = false
            val mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            mediaRecorder.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                try {
                    applyPreferredInputDevice(preferredInputDeviceId)
                } catch (error: RecordingSessionException) {
                    if (preferredInputDeviceId == null ||
                        error.code != "INPUT_DEVICE_UNAVAILABLE"
                    ) {
                        throw error
                    }
                    applyPreferredInputDevice(null)
                    fellBackFromUnavailablePreferredInput = true
                }
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(AudioContract.SAMPLE_RATE_HZ)
                setAudioEncodingBitRate(AudioContract.BIT_RATE)
                setAudioChannels(AudioContract.CHANNEL_COUNT)
                setOutputFile(staging.absolutePath)
                prepare()
                start()
            }
            recorder = mediaRecorder
            if (fellBackFromUnavailablePreferredInput) {
                inputSelection.markFallback(RecordingInputFallbackReasons.DEVICE_DISCONNECTED)
            } else {
                inputSelection.select(preferredInputDeviceId)
            }
            telemetrySampler =
                RecordingTelemetrySampler {
                    val routedDevice =
                        mediaRecorder
                            .routedInputDevice()
                            ?.toRecordingInputDeviceDescriptor()
                    RawRecordingTelemetry(
                        amplitude = mediaRecorder.maxAmplitude,
                        deviceType = routedDevice?.deviceType,
                        deviceId = routedDevice?.id,
                        deviceName = routedDevice?.name,
                    )
                }
            next = next.copy(
                state = RecordingStates.RECORDING,
                activeSinceMs = System.currentTimeMillis(),
                updatedAtMs = System.currentTimeMillis(),
            )
            persist(next)
            return next
        } catch (e: RecordingSessionException) {
            releaseRecorder()
            staging.delete()
            next = next.copy(
                state = RecordingStates.FAILED,
                activeSinceMs = null,
                updatedAtMs = System.currentTimeMillis(),
                errorCategory = e.code.lowercase(),
            )
            persistBestEffort(next)
            throw e
        } catch (e: Exception) {
            releaseRecorder()
            staging.delete()
            next = next.copy(
                state = RecordingStates.FAILED,
                activeSinceMs = null,
                updatedAtMs = System.currentTimeMillis(),
                errorCategory = "start_failed",
            )
            persistBestEffort(next)
            throw RecordingSessionException("START_FAILED", "启动录音失败")
        }
    }

    @Synchronized
    fun pause(): RecordingJournal {
        val current = requireState(RecordingStates.RECORDING)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            throw RecordingSessionException("UNSUPPORTED", "当前系统版本不支持暂停录音")
        }
        try {
            recorder?.pause()
            val now = System.currentTimeMillis()
            val next = current.copy(
                state = RecordingStates.PAUSED,
                accumulatedMs = current.elapsedMs(now),
                activeSinceMs = null,
                updatedAtMs = now,
            )
            persist(next)
            return next
        } catch (_: Exception) {
            throw RecordingSessionException("PAUSE_FAILED", "暂停录音失败")
        }
    }

    @Synchronized
    fun resume(): RecordingJournal {
        val current = requireState(RecordingStates.PAUSED)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            throw RecordingSessionException("UNSUPPORTED", "当前系统版本不支持继续录音")
        }
        try {
            recorder?.resume()
            val now = System.currentTimeMillis()
            val next = current.copy(
                state = RecordingStates.RECORDING,
                activeSinceMs = now,
                updatedAtMs = now,
            )
            persist(next)
            return next
        } catch (_: Exception) {
            throw RecordingSessionException("RESUME_FAILED", "继续录音失败")
        }
    }

    @Synchronized
    fun stop(reason: String = "user_stop"): RecordingSessionResult {
        val current = journal
            ?: throw RecordingSessionException("INVALID_STATE", "当前没有正在进行的录音")
        if (current.state !in ACTIVE_STATES || recorder == null) {
            if (current.state == RecordingStates.COMPLETED) {
                return completedResult(current)
            }
            throw RecordingSessionException("INVALID_STATE", "当前没有正在进行的录音")
        }

        val now = System.currentTimeMillis()
        var finalizing = current.copy(
            state = RecordingStates.FINALIZING,
            accumulatedMs = current.elapsedMs(now),
            activeSinceMs = null,
            updatedAtMs = now,
            stopReason = reason,
            errorCategory = null,
        )
        persistBestEffort(finalizing)

        try {
            recorder?.stop()
            releaseRecorder()
            val staging = File(finalizing.stagingPath)
            val measuredDuration = validator.durationMs(staging)
                ?: throw RecordingSessionException("INVALID_MEDIA", "录音文件未能完成，请从恢复入口处理")
            val canonical = File(finalizing.canonicalPath)
            canonical.parentFile?.mkdirs()
            if (canonical.exists() && !canonical.delete()) {
                throw RecordingSessionException("FINALIZE_FAILED", "录音目标文件无法替换")
            }
            if (!staging.renameTo(canonical)) {
                throw RecordingSessionException("FINALIZE_FAILED", "录音文件无法提交到正式存储")
            }
            if (!validator.isPlayable(canonical)) {
                throw RecordingSessionException("INVALID_MEDIA", "录音文件校验失败")
            }
            finalizing = finalizing.copy(
                state = RecordingStates.COMPLETED,
                accumulatedMs = measuredDuration,
                updatedAtMs = System.currentTimeMillis(),
            )
            persist(finalizing)
            return completedResult(finalizing)
        } catch (e: RecordingSessionException) {
            releaseRecorder()
            persistStopFailure(finalizing, e.code.lowercase())
            throw e
        } catch (_: Exception) {
            releaseRecorder()
            persistStopFailure(finalizing, "stop_failed")
            throw RecordingSessionException("STOP_FAILED", "停止录音失败，临时文件已保留")
        }
    }

    @Synchronized
    fun snapshot(): RecordingJournal? = journal

    @Synchronized
    fun telemetrySnapshot(): RecordingTelemetrySnapshot {
        val state = journal?.state ?: RecordingStates.IDLE
        val snapshot = telemetrySampler?.snapshot(state)
            ?: RecordingTelemetrySampler { error("recorder unavailable") }.snapshot(state)
        return snapshot.copy(
            preferredDeviceId = inputSelection.preferredDeviceId,
            fallbackReason = inputSelection.fallbackReason,
            selectionSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M,
        )
    }

    @Synchronized
    fun selectInputDevice(deviceId: Int?): RecordingTelemetrySnapshot {
        val current = journal
        if (current?.state !in INPUT_SELECTABLE_STATES || recorder == null) {
            throw RecordingSessionException("INVALID_STATE", "当前没有可切换输入的录音")
        }
        val mediaRecorder = recorder
            ?: throw RecordingSessionException("INVALID_STATE", "当前没有可切换输入的录音")
        mediaRecorder.applyPreferredInputDevice(deviceId)
        inputSelection.select(deviceId)
        return telemetrySnapshot()
    }

    @Synchronized
    fun handleInputDevicesRemoved(removedDeviceIds: Set<Int>): RecordingInputDisconnectOutcome {
        if (!inputSelection.handleRemovedDevices(removedDeviceIds)) {
            return RecordingInputDisconnectOutcome.UNCHANGED
        }
        val fellBack =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                runCatching { recorder?.setPreferredDevice(null) == true }.getOrDefault(false)
            } else {
                true
            }
        return if (fellBack) {
            RecordingInputDisconnectOutcome.FALLBACK_TO_AUTOMATIC
        } else {
            RecordingInputDisconnectOutcome.STOP_REQUIRED
        }
    }

    @Synchronized
    fun hasSafeStorageReserve(): Boolean = storageGuard.hasSafeReserve()

    private fun requireState(expected: String): RecordingJournal {
        val current = journal
        if (current?.state != expected || recorder == null) {
            throw RecordingSessionException("INVALID_STATE", "录音状态已变化，请刷新后重试")
        }
        return current
    }

    private fun persist(next: RecordingJournal) {
        journal = next
        journalStore.write(next)
    }

    private fun persistBestEffort(next: RecordingJournal) {
        journal = next
        runCatching { journalStore.write(next) }
    }

    private fun persistStopFailure(current: RecordingJournal, category: String) {
        val staging = File(current.stagingPath)
        val canonical = File(current.canonicalPath)
        val playable = validator.isPlayable(canonical) || validator.isPlayable(staging)
        persistBestEffort(
            current.copy(
                state = if (playable) RecordingStates.RECOVERABLE else RecordingStates.INVALID,
                activeSinceMs = null,
                updatedAtMs = System.currentTimeMillis(),
                errorCategory = category,
            ),
        )
    }

    private fun completedResult(current: RecordingJournal): RecordingSessionResult =
        RecordingSessionResult(
            sessionId = current.sessionId,
            path = current.canonicalPath,
            durationMs = current.accumulatedMs.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
            state = RecordingStates.COMPLETED,
            stopReason = current.stopReason,
        )

    private fun createStagingFile(sessionId: String): File {
        val root = File(recordingRoot(), AudioContract.RECORDING_IN_PROGRESS_DIR_NAME)
        root.mkdirs()
        return File(root, "record-$sessionId.${AudioContract.RECORDING_STAGING_EXTENSION}")
    }

    private fun createCanonicalFile(sessionId: String): File {
        val root = File(recordingRoot(), AudioContract.RECORDING_COMPLETE_DIR_NAME)
        root.mkdirs()
        return File(root, "record-$sessionId.${AudioContract.RECORDING_EXTENSION}")
    }

    private fun recordingRoot(): File =
        File(
            File(context.filesDir, AudioContract.MEETING_DIR_NAME),
            AudioContract.RECORDING_DIR_NAME,
        )

    private fun MediaRecorder.applyPreferredInputDevice(deviceId: Int?) {
        if (deviceId == null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !setPreferredDevice(null)) {
                throw RecordingSessionException("INPUT_SELECTION_FAILED", "无法恢复系统自动输入")
            }
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            throw RecordingSessionException(
                "INPUT_SELECTION_UNSUPPORTED",
                "当前 Android 版本仅支持系统自动选择录音输入",
            )
        }
        if (!setPreferredDevice(inputDeviceCatalog.requireSelectable(deviceId))) {
            throw RecordingSessionException("INPUT_SELECTION_FAILED", "无法切换到所选麦克风")
        }
    }

    private fun releaseRecorder() {
        runCatching { recorder?.release() }
        recorder = null
        telemetrySampler = null
    }

    companion object {
        private val ACTIVE_STATES = setOf(
            RecordingStates.RECORDING,
            RecordingStates.PAUSED,
            RecordingStates.FINALIZING,
        )
        private val INPUT_SELECTABLE_STATES = setOf(
            RecordingStates.RECORDING,
            RecordingStates.PAUSED,
        )
    }
}

private fun MediaRecorder.routedInputDevice(): android.media.AudioDeviceInfo? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
    return routedDevice
}
