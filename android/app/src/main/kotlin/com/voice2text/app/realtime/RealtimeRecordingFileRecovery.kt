package com.voice2text.app.realtime

import java.io.File
import java.util.concurrent.TimeUnit

class RealtimeRecordingFileRecovery(
    private val recordingsDir: File,
) {
    fun cleanupStaleTempFiles(nowMs: Long = System.currentTimeMillis()): Int {
        if (!recordingsDir.exists() || !recordingsDir.isDirectory) return 0
        val expireMs = TimeUnit.HOURS.toMillis(12)
        var deleted = 0
        recordingsDir.listFiles()
            ?.filter { it.isFile && it.name.endsWith(".wav.tmp") }
            ?.filter { nowMs - it.lastModified() > expireMs }
            ?.forEach { file ->
                if (file.delete()) {
                    deleted += 1
                }
            }
        return deleted
    }
}
