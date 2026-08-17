package com.voice2text.app.sharing

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class MeetingRangeVttShareSmokeTest {
    @Test
    fun testRangeVttCanBeReadBySystemReceiver() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val targetContext = instrumentation.targetContext
        val testContext = instrumentation.context
        val source =
            File(targetContext.filesDir, "meetings/device-smoke/range.vtt").apply {
                parentFile?.mkdirs()
                writeText(VTT_CONTENT, Charsets.UTF_8)
            }
        val expectedBytes = source.readBytes()
        val prepared =
            MeetingShareCoordinator(targetContext).prepareShare(
                sourcePath = source.absolutePath,
                displayName = "range-smoke.vtt",
            )
        assertEquals("text/vtt", prepared.mimeType)

        val receiptLatch = CountDownLatch(1)
        var receiptText: String? = null
        val receiver =
            object : BroadcastReceiver() {
                override fun onReceive(
                    context: Context?,
                    intent: Intent?,
                ) {
                    receiptText =
                        intent?.getStringExtra(
                            "com.voice2text.app.test.SHARE_RECEIPT_VALUE",
                        )
                    receiptLatch.countDown()
                }
            }
        val filter = IntentFilter("com.voice2text.app.test.SHARE_RECEIPT")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            targetContext.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            targetContext.registerReceiver(receiver, filter)
        }
        val intent =
            Intent(Intent.ACTION_SEND).apply {
                setClassName(
                    testContext.packageName,
                    "com.voice2text.app.test.ShareReceiverActivity",
                )
                type = prepared.mimeType
                putExtra(Intent.EXTRA_STREAM, prepared.uri)
                putExtra(
                    "com.voice2text.app.test.FINISH_AFTER_VERIFICATION",
                    true,
                )
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        try {
            testContext.startActivity(intent)
            assertTrue(
                "share receiver did not return a receipt",
                receiptLatch.await(5, TimeUnit.SECONDS),
            )
        } finally {
            targetContext.unregisterReceiver(receiver)
        }

        val expectedHash = sha256(expectedBytes)
        assertEquals(
            "share read ok bytes=${expectedBytes.size} sha256=$expectedHash",
            receiptText,
        )
        Log.i(
            TAG,
            "range VTT share ok mime=${prepared.mimeType} " +
                "bytes=${expectedBytes.size} sha256=$expectedHash",
        )

        assertTrue(MeetingShareCoordinator(targetContext).discardExport(prepared.path))
        assertTrue(source.delete())
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest
            .getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }

    private companion object {
        const val TAG = "Voice2TextDeviceTest"
        const val VTT_CONTENT =
            "WEBVTT\n\n" +
                "1\n" +
                "01:02:03.004 --> 01:02:05.006\n" +
                "范围导出 <reviewed> & verified\n"
    }
}
