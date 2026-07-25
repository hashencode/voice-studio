package com.voice2text.app.test;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Test-APK-owned provider used to prove that Voice2Text can consume a read-only
 * content URI originating from another application.
 */
public final class ShareFixtureProvider extends ContentProvider {
    private static final String FILE_NAME = "external-share-fixture.wav";

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        return "audio/wav";
    }

    @Override
    public Cursor query(
            Uri uri,
            String[] projection,
            String selection,
            String[] selectionArgs,
            String sortOrder
    ) {
        File fixture = fixture();
        MatrixCursor result = new MatrixCursor(
                new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}
        );
        result.addRow(new Object[]{FILE_NAME, fixture.length()});
        return result;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) {
            throw new FileNotFoundException("read-only fixture");
        }
        return ParcelFileDescriptor.open(fixture(), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    private File fixture() {
        return new File(new File(getContext().getCacheDir(), "external-share"), FILE_NAME);
    }
}
