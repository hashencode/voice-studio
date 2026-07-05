package com.voice2text.app

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.voice2text.app.build.BuildInfoProvider
import com.voice2text.app.contracts.AudioContract
import com.voice2text.app.recording.RecordingSessionException
import com.voice2text.app.recording.RealtimeRecordingSession
import com.voice2text.app.recording.StandardRecordingSession
import com.voice2text.app.realtime.RealtimeTranscriptionEvent
import com.voice2text.app.transcription.TranscriptionRequest
import com.voice2text.app.transcription.TranscriptionEngineRouter
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val tag = "Voice2TextNative"
    private val channelName = AudioContract.RECORDER_CHANNEL
    private val mainHandler = Handler(Looper.getMainLooper())

    private val standardSession by lazy { StandardRecordingSession(this) }
    private val realtimeSession by lazy { RealtimeRecordingSession(this, ::emitRealtimeEvent) }
    private val buildInfoProvider by lazy { BuildInfoProvider(this) }
    private val transcriptionRouter by lazy { TranscriptionEngineRouter(this) }
    private var realtimeEventSink: EventChannel.EventSink? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call: MethodCall, result: MethodChannel.Result ->
                when (call.method) {
                    "start" -> handleStart(result)
                    "pause" -> handlePause(result)
                    "resume" -> handleResume(result)
                    "stop" -> handleStop(result)
                    "startRealtime" -> handleRealtimeStart(result)
                    "pauseRealtime" -> handleRealtimePause(result)
                    "resumeRealtime" -> handleRealtimeResume(result)
                    "stopRealtime" -> handleRealtimeStop(result)
                    "getBuildInfo" -> handleGetBuildInfo(result)
                    "transcribe" -> handleTranscribe(call, result)
                    else -> result.notImplemented()
                }
            }

        EventChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            AudioContract.TRANSCRIPTION_EVENTS_CHANNEL,
        ).setStreamHandler(
            object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                    realtimeEventSink = events
                }

                override fun onCancel(arguments: Any?) {
                    realtimeEventSink = null
                }
            },
        )
    }

    private fun emitRealtimeEvent(event: RealtimeTranscriptionEvent) {
        mainHandler.post {
            realtimeEventSink?.success(event.toPayload())
        }
    }

    private fun handleStart(result: MethodChannel.Result) {
        try {
            standardSession.start()
            result.success(null)
        } catch (e: RecordingSessionException) {
            result.error(e.code, e.message, null)
        }
    }

    private fun handlePause(result: MethodChannel.Result) {
        try {
            standardSession.pause()
            result.success(null)
        } catch (e: RecordingSessionException) {
            result.error(e.code, e.message, null)
        }
    }

    private fun handleResume(result: MethodChannel.Result) {
        try {
            standardSession.resume()
            result.success(null)
        } catch (e: RecordingSessionException) {
            result.error(e.code, e.message, null)
        }
    }

    private fun handleStop(result: MethodChannel.Result) {
        try {
            val recording = standardSession.stop()
            val payload = hashMapOf<String, Any>(
                "path" to recording.path,
                "durationMs" to recording.durationMs,
            )

            result.success(payload)
        } catch (e: RecordingSessionException) {
            result.error(e.code, e.message, null)
        }
    }

    private fun handleRealtimeStart(result: MethodChannel.Result) {
        try {
            realtimeSession.start()
            result.success(null)
        } catch (e: RecordingSessionException) {
            result.error(e.code, e.message, null)
        }
    }

    private fun handleRealtimePause(result: MethodChannel.Result) {
        try {
            realtimeSession.pause()
            result.success(null)
        } catch (e: RecordingSessionException) {
            result.error(e.code, e.message, null)
        }
    }

    private fun handleRealtimeResume(result: MethodChannel.Result) {
        try {
            realtimeSession.resume()
            result.success(null)
        } catch (e: RecordingSessionException) {
            result.error(e.code, e.message, null)
        }
    }

    private fun handleRealtimeStop(result: MethodChannel.Result) {
        try {
            val recording = realtimeSession.stop()
            val payload = hashMapOf<String, Any>(
                "path" to recording.path,
                "durationMs" to recording.durationMs,
            )
            result.success(payload)
        } catch (e: RecordingSessionException) {
            result.error(e.code, e.message, null)
        }
    }

    private fun handleTranscribe(call: MethodCall, result: MethodChannel.Result) {
        val recordingPath = call.argument<String>("recordingPath") ?: ""
        val durationMs = call.argument<Int>("durationMs") ?: 0
        val modelId = call.argument<String>("modelId") ?: "paraformer-zh"
        val sampleRateHz = call.argument<Int>("sampleRateHz") ?: 16000
        val enablePunctuation = call.argument<Boolean>("enablePunctuation") ?: true
        val enableDenoise = call.argument<Boolean>("enableDenoise") ?: true
        val engineMode = call.argument<String>("engineMode") ?: "auto"
        val started = System.currentTimeMillis()

        try {
            val request = TranscriptionRequest(
                recordingPath = recordingPath,
                durationMs = durationMs,
                modelId = modelId,
                sampleRateHz = sampleRateHz,
                enablePunctuation = enablePunctuation,
                enableDenoise = enableDenoise,
                engineMode = engineMode,
            )
            val text = transcriptionRouter.resolve(engineMode).transcribe(request)
            Log.i(
                tag,
                "transcribe ok mode=$engineMode model=$modelId durationMs=$durationMs costMs=${System.currentTimeMillis() - started}",
            )
            result.success(text)
        } catch (e: IllegalArgumentException) {
            Log.e(tag, "transcribe invalid_arg: ${e.message}", e)
            result.error("INVALID_ARG", e.message ?: "参数错误", null)
        } catch (e: Exception) {
            Log.e(tag, "transcribe failed mode=$engineMode model=$modelId path=$recordingPath", e)
            result.error("TRANSCRIBE_FAILED", e.message ?: "转写失败", null)
        }
    }

    private fun handleGetBuildInfo(result: MethodChannel.Result) {
        try {
            result.success(buildInfoProvider.getBuildInfo())
        } catch (e: Exception) {
            result.error("BUILD_INFO_FAILED", e.message ?: "读取构建信息失败", null)
        }
    }
}
