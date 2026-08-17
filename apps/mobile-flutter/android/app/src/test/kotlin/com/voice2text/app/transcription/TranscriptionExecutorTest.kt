package com.voice2text.app.transcription

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class TranscriptionExecutorTest {
    @Test
    fun workRunsOffCallerThreadAndUsesOneFifoConsumer() {
        val callerThread = Thread.currentThread().name
        val concurrent = AtomicInteger(0)
        val maxConcurrent = AtomicInteger(0)
        val executionThreads = Collections.synchronizedList(mutableListOf<String>())
        val engine =
            object : TranscriptionEngine {
                override fun transcribe(
                    request: TranscriptionRequest,
                    executionContext: TranscriptionExecutionContext,
                ): TranscriptionResult {
                    val active = concurrent.incrementAndGet()
                    maxConcurrent.updateAndGet { current -> maxOf(current, active) }
                    executionThreads.add(Thread.currentThread().name)
                    executionContext.report("decode", 0.8)
                    Thread.sleep(30)
                    concurrent.decrementAndGet()
                    return TranscriptionResult.singleText(request.modelId, 1000)
                }
            }
        val executor = TranscriptionExecutor(engine)
        val completed = Collections.synchronizedList(mutableListOf<Int>())
        val latch = CountDownLatch(2)
        try {
            executor.submit(1, request("first")) {
                completed.add(1)
                latch.countDown()
            }
            executor.submit(2, request("second")) {
                completed.add(2)
                latch.countDown()
            }

            assertTrue(latch.await(3, TimeUnit.SECONDS))
            assertEquals(listOf(1, 2), completed)
            assertEquals(1, maxConcurrent.get())
            assertTrue(executionThreads.isNotEmpty())
            assertFalse(executionThreads.any { it == callerThread })
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun processingCancellationIsObservedBetweenStages() {
        val started = CountDownLatch(1)
        val engine =
            object : TranscriptionEngine {
                override fun transcribe(
                    request: TranscriptionRequest,
                    executionContext: TranscriptionExecutionContext,
                ): TranscriptionResult {
                    started.countDown()
                    while (true) {
                        executionContext.throwIfCanceled()
                        Thread.sleep(5)
                    }
                }
            }
        val executor = TranscriptionExecutor(engine)
        val completed = CountDownLatch(1)
        var outcome: TranscriptionExecutionOutcome? = null
        try {
            executor.submit(9, request("cancel")) {
                outcome = it
                completed.countDown()
            }
            assertTrue(started.await(1, TimeUnit.SECONDS))
            assertTrue(executor.cancel(9))
            assertTrue(completed.await(1, TimeUnit.SECONDS))
            assertEquals("CANCELED", outcome?.errorCode)
            assertEquals("cancellation", outcome?.errorStage)
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun aHigherAttemptForTheSameJobRunsAgain() {
        val calls = AtomicInteger(0)
        val engine =
            object : TranscriptionEngine {
                override fun transcribe(
                    request: TranscriptionRequest,
                    executionContext: TranscriptionExecutionContext,
                ): TranscriptionResult =
                    TranscriptionResult.singleText(
                        "attempt-${calls.incrementAndGet()}",
                        1000,
                    )
            }
        val executor = TranscriptionExecutor(engine)
        val first = CountDownLatch(1)
        val second = CountDownLatch(1)
        var firstText: String? = null
        var secondText: String? = null
        try {
            executor.submit(12, request("retry", attemptCount = 1)) {
                firstText = it.text
                first.countDown()
            }
            assertTrue(first.await(1, TimeUnit.SECONDS))
            executor.submit(12, request("retry", attemptCount = 2)) {
                secondText = it.text
                second.countDown()
            }
            assertTrue(second.await(1, TimeUnit.SECONDS))
            assertEquals("attempt-1", firstText)
            assertEquals("attempt-2", secondText)
            assertEquals(2, calls.get())
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun punctuationFailureKeepsItsOwnStageAndErrorCode() {
        val engine =
            object : TranscriptionEngine {
                override fun transcribe(
                    request: TranscriptionRequest,
                    executionContext: TranscriptionExecutionContext,
                ): TranscriptionResult {
                    executionContext.report("punctuation", 0.96)
                    throw IllegalStateException("punctuation failed")
                }
            }
        val executor = TranscriptionExecutor(engine)
        val completed = CountDownLatch(1)
        var outcome: TranscriptionExecutionOutcome? = null
        try {
            executor.submit(13, request("punctuation", enablePunctuation = true)) {
                outcome = it
                completed.countDown()
            }

            assertTrue(completed.await(1, TimeUnit.SECONDS))
            assertEquals("PUNCTUATION_FAILED", outcome?.errorCode)
            assertEquals("punctuation", outcome?.errorStage)
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun itnFailureKeepsItsOwnStageAndErrorCode() {
        val engine =
            object : TranscriptionEngine {
                override fun transcribe(
                    request: TranscriptionRequest,
                    executionContext: TranscriptionExecutionContext,
                ): TranscriptionResult {
                    executionContext.report("itn", 0.97)
                    throw IllegalStateException("itn failed")
                }
            }
        val executor = TranscriptionExecutor(engine)
        val completed = CountDownLatch(1)
        var outcome: TranscriptionExecutionOutcome? = null
        try {
            executor.submit(14, request("itn")) {
                outcome = it
                completed.countDown()
            }

            assertTrue(completed.await(1, TimeUnit.SECONDS))
            assertEquals("ITN_FAILED", outcome?.errorCode)
            assertEquals("itn", outcome?.errorStage)
        } finally {
            executor.shutdownNow()
        }
    }

    private fun request(
        modelId: String,
        attemptCount: Int = 1,
        enablePunctuation: Boolean = false,
    ) =
        TranscriptionRequest(
            recordingPath = "/private/audio.m4a",
            durationMs = 1000,
            modelId = modelId,
            sampleRateHz = 16000,
            enablePunctuation = enablePunctuation,
            enableDenoise = false,
            attemptCount = attemptCount,
        )
}
