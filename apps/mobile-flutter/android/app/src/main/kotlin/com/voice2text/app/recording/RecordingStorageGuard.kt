package com.voice2text.app.recording

import android.os.StatFs
import com.voice2text.app.contracts.AudioContract
import java.io.File

class RecordingStorageGuard(
    private val availableBytesProvider: () -> Long,
    private val minimumReserveBytes: Long = AudioContract.MINIMUM_STORAGE_RESERVE_BYTES,
) {
    constructor(root: File) : this(
        availableBytesProvider = { StatFs(root.absolutePath).availableBytes },
    )

    fun availableBytes(): Long = availableBytesProvider().coerceAtLeast(0L)

    fun canStart(): Boolean = availableBytes() >= minimumReserveBytes

    fun hasSafeReserve(): Boolean = availableBytes() >= minimumReserveBytes

    fun requireCanStart() {
        if (!canStart()) {
            throw RecordingSessionException("LOW_STORAGE", "可用存储空间不足，至少需要保留 512 MB")
        }
    }
}
