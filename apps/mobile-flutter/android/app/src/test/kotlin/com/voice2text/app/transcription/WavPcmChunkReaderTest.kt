package com.voice2text.app.transcription

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.RandomAccessFile

class WavPcmChunkReaderTest {
    @Test
    fun twoHourSyntheticWavUsesBoundedChunks() {
        val totalSamples = 2L * 60L * 60L * SAMPLE_RATE
        val file = sparseWav(totalSamples)
        val reader = WavPcmChunkReader(file)
        var observedSamples = 0L
        var maxChunkSamples = 0

        reader.readChunks(maxSamplesPerChunk = 16_000) { _, samples ->
            observedSamples += samples.size
            maxChunkSamples = maxOf(maxChunkSamples, samples.size)
        }

        assertEquals(totalSamples, reader.format.totalSamples)
        assertEquals(totalSamples, observedSamples)
        assertTrue(maxChunkSamples <= 16_000)
    }

    @Test
    fun cancellationIsCheckedBetweenChunks() {
        val file = sparseWav(64_000)
        val reader = WavPcmChunkReader(file)
        var chunks = 0

        assertThrows(TranscriptionCanceledException::class.java) {
            reader.readChunks(
                maxSamplesPerChunk = 8_000,
                cancellationRequested = { chunks >= 1 },
            ) { _, _ ->
                chunks += 1
            }
        }
        assertEquals(1, chunks)
    }

    private fun sparseWav(totalSamples: Long): File {
        val file = File.createTempFile("voice2text-", ".wav").apply { deleteOnExit() }
        val dataBytes = totalSamples * 2L
        RandomAccessFile(file, "rw").use { output ->
            output.writeBytes("RIFF")
            writeUInt32(output, 36L + dataBytes)
            output.writeBytes("WAVE")
            output.writeBytes("fmt ")
            writeUInt32(output, 16)
            writeUInt16(output, 1)
            writeUInt16(output, 1)
            writeUInt32(output, SAMPLE_RATE.toLong())
            writeUInt32(output, SAMPLE_RATE * 2L)
            writeUInt16(output, 2)
            writeUInt16(output, 16)
            output.writeBytes("data")
            writeUInt32(output, dataBytes)
            output.setLength(44L + dataBytes)
        }
        return file
    }

    private fun writeUInt16(
        output: RandomAccessFile,
        value: Int,
    ) {
        output.write(value and 0xff)
        output.write((value ushr 8) and 0xff)
    }

    private fun writeUInt32(
        output: RandomAccessFile,
        value: Long,
    ) {
        repeat(4) { index ->
            output.write(((value ushr (index * 8)) and 0xff).toInt())
        }
    }

    private companion object {
        const val SAMPLE_RATE = 16_000L
    }
}
