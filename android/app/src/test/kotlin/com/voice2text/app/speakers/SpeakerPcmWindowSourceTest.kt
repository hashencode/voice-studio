package com.voice2text.app.speakers

import com.voice2text.app.transcription.TranscriptionCanceledException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.RandomAccessFile

class SpeakerPcmWindowSourceTest {
    @Test
    fun emitsOverlappingWindowsWithAbsoluteSampleRanges() {
        val source = SpeakerPcmWindowSource(
            file = pcmWav((0 until 20).map(Int::toShort)),
            windowSamples = 8,
            overlapSamples = 2,
            readChunkSamples = 3,
        )
        val windows = mutableListOf<SpeakerPcmWindow>()

        source.readWindows { windows += it }

        assertEquals(listOf(0L, 6L, 12L), windows.map { it.startSample })
        assertEquals(listOf(8L, 14L, 20L), windows.map { it.endSampleExclusive })
        assertEquals(listOf(false, false, true), windows.map { it.isFinal })
        assertArrayEquals(
            windows[0].samples.copyOfRange(6, 8),
            windows[1].samples.copyOfRange(0, 2),
            0.0f,
        )
        assertArrayEquals(
            windows[1].samples.copyOfRange(6, 8),
            windows[2].samples.copyOfRange(0, 2),
            0.0f,
        )
    }

    @Test
    fun emitsShortFinalTailWithoutCrossingFileEnd() {
        val source = SpeakerPcmWindowSource(
            file = pcmWav((0 until 17).map(Int::toShort)),
            windowSamples = 8,
            overlapSamples = 2,
            readChunkSamples = 5,
        )
        val windows = mutableListOf<SpeakerPcmWindow>()

        source.readWindows { windows += it }

        assertEquals(listOf(8, 8, 5), windows.map { it.samples.size })
        assertEquals(17L, windows.last().endSampleExclusive)
        assertTrue(windows.last().isFinal)
        assertTrue(windows.all { it.endSampleExclusive <= source.format.totalSamples })
    }

    @Test
    fun cancellationStopsBeforeAnotherWindowIsDelivered() {
        val source = SpeakerPcmWindowSource(
            file = pcmWav((0 until 40).map(Int::toShort)),
            windowSamples = 8,
            overlapSamples = 2,
            readChunkSamples = 3,
        )
        var delivered = 0

        assertThrows(TranscriptionCanceledException::class.java) {
            source.readWindows(
                cancellationRequested = { delivered == 1 },
            ) {
                delivered += 1
            }
        }

        assertEquals(1, delivered)
    }

    @Test
    fun twoHourPlanHasDurationIndependentPcmResidency() {
        val totalSamples = 2L * 60L * 60L * SAMPLE_RATE
        val source = SpeakerPcmWindowSource(
            file = sparseWav(totalSamples),
            windowSamples = 30 * SAMPLE_RATE,
            overlapSamples = 5 * SAMPLE_RATE,
            readChunkSamples = SAMPLE_RATE,
        )

        assertEquals(288L, source.plannedWindowCount)
        assertTrue(
            source.maximumResidentPcmSamples <=
                (2 * source.windowSamples) + source.readChunkSamples,
        )
        assertFalse(source.maximumResidentPcmSamples.toLong() >= totalSamples)
    }

    @Test
    fun invalidSampleRateFailsClosed() {
        assertThrows(IllegalArgumentException::class.java) {
            SpeakerPcmWindowSource(
                file = sparseWav(totalSamples = 16_000, sampleRate = 8_000),
                windowSamples = 8_000,
                overlapSamples = 1_000,
            )
        }
    }

    private fun pcmWav(samples: List<Short>): File {
        val file = sparseWav(samples.size.toLong())
        RandomAccessFile(file, "rw").use { output ->
            output.seek(44)
            samples.forEach { writeUInt16(output, it.toInt() and 0xffff) }
        }
        return file
    }

    private fun sparseWav(
        totalSamples: Long,
        sampleRate: Int = SAMPLE_RATE,
    ): File {
        val file = File.createTempFile("speaker-window-", ".wav").apply { deleteOnExit() }
        val dataBytes = totalSamples * 2L
        RandomAccessFile(file, "rw").use { output ->
            output.writeBytes("RIFF")
            writeUInt32(output, 36L + dataBytes)
            output.writeBytes("WAVE")
            output.writeBytes("fmt ")
            writeUInt32(output, 16)
            writeUInt16(output, 1)
            writeUInt16(output, 1)
            writeUInt32(output, sampleRate.toLong())
            writeUInt32(output, sampleRate * 2L)
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
        const val SAMPLE_RATE = 16_000
    }
}
