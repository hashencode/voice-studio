package com.voice2text.app.test;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

public final class ShareSenderActivity extends Activity {
    private static final int SAMPLE_RATE = 16_000;
    private static final int DURATION_SECONDS = 2;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView status = new TextView(this);
        status.setTextSize(18);
        status.setPadding(48, 48, 48, 48);
        setContentView(status);
        try {
            File root = new File(getCacheDir(), "external-share");
            if (!root.exists() && !root.mkdirs()) {
                throw new IllegalStateException("fixture directory unavailable");
            }
            File fixture = new File(root, "external-share-fixture.wav");
            try (FileOutputStream output = new FileOutputStream(fixture, false)) {
                output.write(buildWav());
                output.getFD().sync();
            }
            Uri uri = Uri.parse(
                    "content://com.voice2text.app.test.sender/external-share-fixture.wav"
            );
            Intent share = new Intent(Intent.ACTION_SEND)
                    .setClassName("com.voice2text.app", "com.voice2text.app.MainActivity")
                    .setType("audio/wav")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(share);
            status.setText("External audio share sent\n" + fixture.length() + " bytes");
        } catch (Throwable error) {
            status.setText("External audio share failed\n" + error.getClass().getSimpleName());
        }
    }

    private static byte[] buildWav() throws Exception {
        int sampleCount = SAMPLE_RATE * DURATION_SECONDS;
        int dataBytes = sampleCount * 2;
        ByteArrayOutputStream output = new ByteArrayOutputStream(44 + dataBytes);
        writeAscii(output, "RIFF");
        writeLe32(output, 36 + dataBytes);
        writeAscii(output, "WAVE");
        writeAscii(output, "fmt ");
        writeLe32(output, 16);
        writeLe16(output, 1);
        writeLe16(output, 1);
        writeLe32(output, SAMPLE_RATE);
        writeLe32(output, SAMPLE_RATE * 2);
        writeLe16(output, 2);
        writeLe16(output, 16);
        writeAscii(output, "data");
        writeLe32(output, dataBytes);
        for (int index = 0; index < sampleCount; index += 1) {
            double carrier = Math.sin(2.0 * Math.PI * 220.0 * index / SAMPLE_RATE);
            double envelope = Math.sin(Math.PI * index / sampleCount);
            short sample = (short) Math.round(8_000.0 * carrier * envelope);
            writeLe16(output, sample & 0xffff);
        }
        return output.toByteArray();
    }

    private static void writeAscii(ByteArrayOutputStream output, String value) {
        byte[] bytes = value.getBytes(StandardCharsets.US_ASCII);
        output.write(bytes, 0, bytes.length);
    }

    private static void writeLe16(ByteArrayOutputStream output, int value) {
        output.write(value & 0xff);
        output.write((value >>> 8) & 0xff);
    }

    private static void writeLe32(ByteArrayOutputStream output, int value) {
        output.write(value & 0xff);
        output.write((value >>> 8) & 0xff);
        output.write((value >>> 16) & 0xff);
        output.write((value >>> 24) & 0xff);
    }
}
