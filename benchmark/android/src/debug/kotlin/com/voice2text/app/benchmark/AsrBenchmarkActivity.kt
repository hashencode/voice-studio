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
        writeStatus(
            statusFile,
            JSONObject()
                .put("status", "running")
                .put("startedAtMs", System.currentTimeMillis())
                .put("segmentWindowMs", segmentWindowMs),
        )

        Thread {
            try {
                val result = AsrBenchmarkRunner(this).run(segmentWindowMs)
                val status = JSONObject()
                    .put("status", "done")
                    .put("finishedAtMs", System.currentTimeMillis())
                    .put("reportPath", result["reportPath"])
                    .put("resultCount", result["resultCount"])
                    .put("failureCount", result["failureCount"])
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
