package com.voice2text.app.transcription

import android.content.Context
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

data class TranscriptionExecutionOutcome(
    val result: TranscriptionResult? = null,
    val errorCode: String? = null,
    val errorStage: String? = null,
    val errorMessage: String? = null,
) {
    val successful: Boolean
        get() = result != null

    val text: String?
        get() = result?.mergedText
}

class TranscriptionExecutor internal constructor(
    private val engine: TranscriptionEngine,
    private val executor: ExecutorService = Executors.newSingleThreadExecutor(),
) {
    private data class CompletedJob(
        val attemptCount: Int,
        val outcome: TranscriptionExecutionOutcome,
    )

    private data class Job(
        val request: TranscriptionRequest,
        val canceled: AtomicBoolean = AtomicBoolean(false),
        val callbacks: CopyOnWriteArrayList<(TranscriptionExecutionOutcome) -> Unit> =
            CopyOnWriteArrayList(),
    )

    private val jobs = ConcurrentHashMap<Int, Job>()
    private val completed = ConcurrentHashMap<Int, CompletedJob>()
    private val completionOrder = CopyOnWriteArrayList<Int>()

    @Volatile
    private var eventListener: ((TranscriptionProgressEvent) -> Unit)? = null

    fun setEventListener(listener: (TranscriptionProgressEvent) -> Unit) {
        eventListener = listener
    }

    fun clearEventListener(listener: (TranscriptionProgressEvent) -> Unit) {
        if (eventListener === listener) {
            eventListener = null
        }
    }

    fun submit(
        jobId: Int,
        request: TranscriptionRequest,
        callback: (TranscriptionExecutionOutcome) -> Unit,
    ) {
        completed[jobId]?.let { retained ->
            if (retained.attemptCount == request.attemptCount) {
                callback(retained.outcome)
                return
            }
            completed.remove(jobId, retained)
            completionOrder.remove(jobId)
        }
        val candidate = Job(request = request).apply { callbacks.add(callback) }
        val existing = jobs.putIfAbsent(jobId, candidate)
        if (existing != null) {
            existing.callbacks.add(callback)
            return
        }
        executor.execute { execute(jobId, candidate) }
    }

    fun cancel(jobId: Int): Boolean {
        val job = jobs[jobId] ?: return false
        job.canceled.set(true)
        return true
    }

    fun activeJobIds(): List<Int> = jobs.keys().toList()

    internal fun shutdownNow() {
        executor.shutdownNow()
    }

    private fun execute(
        jobId: Int,
        job: Job,
    ) {
        val context =
            TranscriptionExecutionContext(
                jobId = jobId,
                progressListener = ::emit,
                cancellationRequested = job.canceled::get,
            )
        val outcome =
            try {
                context.report("input", 0.02)
                val result = engine.transcribe(job.request, context)
                context.throwIfCanceled()
                emit(
                    TranscriptionProgressEvent(
                        jobId = jobId,
                        stage = context.currentStage,
                        progress = 0.975,
                        status = "processing",
                    ),
                )
                TranscriptionExecutionOutcome(result = result)
            } catch (_: TranscriptionCanceledException) {
                TranscriptionExecutionOutcome(
                    errorCode = "CANCELED",
                    errorStage = "cancellation",
                    errorMessage = "任务已取消",
                )
            } catch (error: IllegalArgumentException) {
                TranscriptionExecutionOutcome(
                    errorCode = "INVALID_INPUT",
                    errorStage = "input",
                    errorMessage = error.message ?: "输入无效",
                )
            } catch (error: Exception) {
                TranscriptionExecutionOutcome(
                    errorCode = stageErrorCode(context.currentStage),
                    errorStage = context.currentStage,
                    errorMessage = error.message ?: "转写失败",
                )
            }
        completed[jobId] = CompletedJob(job.request.attemptCount, outcome)
        completionOrder.add(jobId)
        trimCompleted()
        jobs.remove(jobId)
        if (!outcome.successful) {
            emit(
                TranscriptionProgressEvent(
                    jobId = jobId,
                    stage = outcome.errorStage ?: "unknown",
                    progress = 1.0,
                    status = if (outcome.errorCode == "CANCELED") "canceled" else "failed",
                    errorCode = outcome.errorCode,
                ),
            )
        }
        job.callbacks.forEach { callback -> callback(outcome) }
    }

    private fun emit(event: TranscriptionProgressEvent) {
        eventListener?.invoke(event)
    }

    private fun trimCompleted() {
        while (completionOrder.size > MAX_RETAINED_OUTCOMES) {
            val oldest = completionOrder.removeAt(0)
            completed.remove(oldest)
        }
    }

    private fun stageErrorCode(stage: String): String =
        when (stage) {
            "input" -> "INVALID_INPUT"
            "transcode" -> "TRANSCODE_FAILED"
            "model" -> "MODEL_NOT_READY"
            "vad" -> "VAD_FAILED"
            "decode" -> "DECODE_FAILED"
            "punctuation" -> "PUNCTUATION_FAILED"
            "itn" -> "ITN_FAILED"
            else -> "TRANSCRIPTION_FAILED"
        }

    companion object {
        private const val MAX_RETAINED_OUTCOMES = 16
        private val legacyJobId = AtomicInteger(-1)

        @Volatile
        private var instance: TranscriptionExecutor? = null

        fun getInstance(context: Context): TranscriptionExecutor =
            instance ?: synchronized(this) {
                instance ?: TranscriptionExecutor(
                    engine = TranscriptionEngineRouter(context.applicationContext).resolve(),
                ).also { instance = it }
            }

        fun nextLegacyJobId(): Int = legacyJobId.getAndDecrement()
    }
}
