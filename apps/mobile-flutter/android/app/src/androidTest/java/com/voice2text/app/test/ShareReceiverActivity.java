package com.voice2text.app.test;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.widget.TextView;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

public final class ShareReceiverActivity extends Activity {
    private static final String TAG = "Voice2TextShareTest";
    private static final String RECEIPT_FILE = "share-receipt.txt";
    private static final String FINISH_AFTER_VERIFICATION =
            "com.voice2text.app.test.FINISH_AFTER_VERIFICATION";
    private static final String RECEIPT_ACTION =
            "com.voice2text.app.test.SHARE_RECEIPT";
    private static final String RECEIPT_EXTRA =
            "com.voice2text.app.test.SHARE_RECEIPT_VALUE";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView status = new TextView(this);
        status.setTextSize(18);
        status.setPadding(48, 48, 48, 48);
        status.setText(verifySharedContent(getIntent()));
        setContentView(status);
        if (getIntent().getBooleanExtra(FINISH_AFTER_VERIFICATION, false)) {
            finish();
        }
    }

    private String verifySharedContent(Intent intent) {
        Uri uri = sharedUri(intent);
        if (uri == null) {
            return recordFailure("missing content URI");
        }
        if (!"content".equals(uri.getScheme())) {
            return recordFailure("unexpected URI scheme");
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long byteCount = 0;
            try (InputStream input = getContentResolver().openInputStream(uri)) {
                if (input == null) {
                    throw new IllegalStateException("content resolver returned no stream");
                }
                byte[] buffer = new byte[8192];
                while (true) {
                    int read = input.read(buffer);
                    if (read < 0) {
                        break;
                    }
                    digest.update(buffer, 0, read);
                    byteCount += read;
                }
            }
            String sha256 = toHex(digest.digest());
            String receipt = "share read ok bytes=" + byteCount + " sha256=" + sha256;
            writeReceipt(receipt);
            Log.i(TAG, receipt);
            return "Share verified\n" + byteCount + " bytes\n" + sha256;
        } catch (Throwable error) {
            return recordFailure(error.getClass().getSimpleName());
        }
    }

    @SuppressWarnings("deprecation")
    private static Uri sharedUri(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        }
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    private String recordFailure(String category) {
        String receipt = "share read failed category=" + category;
        writeReceipt(receipt);
        Log.e(TAG, receipt);
        return "Share verification failed\n" + category;
    }

    private void writeReceipt(String receipt) {
        File target = new File(getFilesDir(), RECEIPT_FILE);
        try (FileOutputStream output = new FileOutputStream(target, false)) {
            output.write(receipt.getBytes(StandardCharsets.UTF_8));
        } catch (Throwable error) {
            Log.e(TAG, "share receipt write failed category=" + error.getClass().getSimpleName());
        }
        sendBroadcast(
                new Intent(RECEIPT_ACTION)
                        .setPackage("com.voice2text.app")
                        .putExtra(RECEIPT_EXTRA, receipt)
        );
    }

    private static String toHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            result.append(String.format("%02x", value & 0xff));
        }
        return result.toString();
    }
}
