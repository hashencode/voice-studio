package com.voice2text.app.realtime

import java.io.File
import java.io.RandomAccessFile

class RealtimeAudioFileWriter(
    private val tempFile: File,
    private val finalFile: File,
    private val sampleRateHz: Int,
    private val channelCount: Int,
) {
    private var raf: RandomAccessFile? = null
    private var dataBytes: Long = 0

    @Synchronized
    fun open() {
        if (!tempFile.parentFile.exists()) {
            tempFile.parentFile.mkdirs()
        }
        raf = RandomAccessFile(tempFile, "rw").also { file ->
            file.setLength(0)
            writeWavHeader(file, sampleRateHz, channelCount, 0)
        }
    }

    @Synchronized
    fun writePcm(data: ByteArray, length: Int = data.size) {
        val file = raf ?: throw IllegalStateException("实时录音文件未打开")
        if (length <= 0) return
        file.write(data, 0, length)
        dataBytes += length.toLong()
    }

    @Synchronized
    fun finish(): File {
        val file = raf ?: throw IllegalStateException("实时录音文件未打开")
        file.seek(0)
        writeWavHeader(file, sampleRateHz, channelCount, dataBytes)
        file.close()
        raf = null

        if (dataBytes <= 0L) {
            tempFile.delete()
            throw IllegalStateException("实时录音没有写入有效音频")
        }
        if (finalFile.exists()) {
            finalFile.delete()
        }
        if (!tempFile.renameTo(finalFile)) {
            throw IllegalStateException("实时录音文件保存失败")
        }
        return finalFile
    }

    @Synchronized
    fun abort() {
        try {
            raf?.close()
        } catch (_: Exception) {
        }
        raf = null
        tempFile.delete()
    }

    companion object {
        fun writeWavFile(
            file: File,
            pcmData: ByteArray,
            sampleRateHz: Int,
            channelCount: Int,
        ) {
            if (!file.parentFile.exists()) {
                file.parentFile.mkdirs()
            }
            RandomAccessFile(file, "rw").use { raf ->
                raf.setLength(0)
                writeWavHeader(raf, sampleRateHz, channelCount, pcmData.size.toLong())
                raf.write(pcmData)
            }
        }

        private fun writeWavHeader(
            file: RandomAccessFile,
            sampleRateHz: Int,
            channelCount: Int,
            dataBytes: Long,
        ) {
            val byteRate = sampleRateHz * channelCount * 2
            val blockAlign = channelCount * 2
            file.writeBytes("RIFF")
            writeIntLE(file, (36L + dataBytes).toInt())
            file.writeBytes("WAVE")
            file.writeBytes("fmt ")
            writeIntLE(file, 16)
            writeShortLE(file, 1)
            writeShortLE(file, channelCount)
            writeIntLE(file, sampleRateHz)
            writeIntLE(file, byteRate)
            writeShortLE(file, blockAlign)
            writeShortLE(file, 16)
            file.writeBytes("data")
            writeIntLE(file, dataBytes.toInt())
        }

        private fun writeIntLE(file: RandomAccessFile, value: Int) {
            file.write(value and 0xFF)
            file.write((value shr 8) and 0xFF)
            file.write((value shr 16) and 0xFF)
            file.write((value shr 24) and 0xFF)
        }

        private fun writeShortLE(file: RandomAccessFile, value: Int) {
            file.write(value and 0xFF)
            file.write((value shr 8) and 0xFF)
        }
    }
}
