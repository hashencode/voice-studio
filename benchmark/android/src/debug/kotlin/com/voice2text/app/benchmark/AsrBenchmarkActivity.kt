package com.voice2text.app.benchmark

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import java.io.File
import org.json.JSONObject

class AsrBenchmarkActivity : Activity() {
    private val tag = "Voice2TextBenchmark"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val statusView = TextView(this)
        statusView.text = "ASR benchmark running"
        setContentView(statusView)

        val segmentWindowMs = intent.getIntExtra("segmentWindowMs", 12000)
        val statusFile = File(filesDir, "asr_benchmark/status.json")
        statusFile.parentFile?.mkdirs()
        val startedAtMs = System.currentTimeMillis()
        fun runningStatus(progress: AsrBenchmarkProgress? = null): JSONObject {
            val status = JSONObject()
                .put("status", "running")
                .put("startedAtMs", startedAtMs)
                .put("updatedAtMs", System.currentTimeMillis())
                .put("segmentWindowMs", segmentWindowMs)
            if (progress != null) {
                status
                    .put("progressStartedAtMs", progress.startedAtMs)
                    .put("progressUpdatedAtMs", progress.updatedAtMs)
                    .put("totalPairs", progress.totalPairs)
                    .put("completedPairs", progress.completedPairs)
                    .put(
                        "progressPercent",
                        if (progress.totalPairs > 0) progress.completedPairs.toDouble() / progress.totalPairs else JSONObject.NULL,
                    )
                    .put("resultCount", progress.resultCount)
                    .put("failureCount", progress.failureCount)
                    .put("currentStage", progress.currentStage)
                    .put("currentModelId", progress.currentModelId ?: JSONObject.NULL)
                    .put("currentProfileId", progress.currentProfileId ?: JSONObject.NULL)
                    .put("currentAudioCaseId", progress.currentAudioCaseId ?: JSONObject.NULL)
            }
            return status
        }
        writeStatus(statusFile, runningStatus())

        Thread {
            try {
                val result = AsrBenchmarkRunner(this) { progress ->
                    writeStatus(statusFile, runningStatus(progress))
                    runOnUiThread {
                        statusView.text = buildString {
                            append("ASR benchmark running\n")
                            append("${progress.completedPairs}/${progress.totalPairs} pairs\n")
                            append(progress.currentStage)
                            progress.currentProfileId?.let { append("\n").append(it) }
                            progress.currentAudioCaseId?.let { append("\n").append(it) }
                        }
                    }
                }.run(segmentWindowMs)
                val status = JSONObject()
                    .put("status", "done")
                    .put("startedAtMs", startedAtMs)
                    .put("finishedAtMs", System.currentTimeMillis())
                    .put("reportPath", result["reportPath"])
                    .put("resultCount", result["resultCount"])
                    .put("failureCount", result["failureCount"])
                    .put("totalPairs", result["totalPairs"])
                    .put("completedPairs", result["completedPairs"])
                    .put("modelsConfigured", result["modelsConfigured"])
                    .put("audioCasesConfigured", result["audioCasesConfigured"])
                writeStatus(statusFile, status)
                runOnUiThread {
                    statusView.text = "ASR benchmark done\n${result["reportPath"]}"
                }
            } catch (e: Exception) {
                Log.e(tag, "ASR benchmark failed", e)
                writeStatus(
                    statusFile,
                    JSONObject()
                        .put("status", "failed")
                        .put("startedAtMs", startedAtMs)
                        .put("finishedAtMs", System.currentTimeMillis())
                        .put("message", e.message ?: "ASR benchmark failed"),
                )
                runOnUiThread {
                    statusView.text = "ASR benchmark failed\n${e.message ?: ""}"
                }
            }
        }.start()
    }

    private fun writeStatus(file: File, status: JSONObject) {
        file.writeText(status.toString(2))
    }
}
