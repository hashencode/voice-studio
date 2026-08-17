package com.voice2text.app.contracts

object AudioContract {
    const val RECORDER_CHANNEL = "voice2text/recorder"
    const val TRANSCRIPTION_EVENT_CHANNEL = "voice2text/transcription_events"

    const val AUDIO_DIR_NAME = "audios"
    const val RECORDING_DIR_NAME = "recordings"
    const val RECORDING_IN_PROGRESS_DIR_NAME = "in-progress"
    const val RECORDING_COMPLETE_DIR_NAME = "complete"
    const val RECORDING_JOURNAL_DIR_NAME = "journals"
    const val RECORDING_JOURNAL_SUFFIX = ".journal.json"
    const val IMPORT_DIR_NAME = "imports"
    const val IMPORT_IN_PROGRESS_DIR_NAME = "in-progress"
    const val IMPORT_COMPLETE_DIR_NAME = "complete"
    const val TRANSCRIPT_EXPORT_DIR_NAME = "transcript-exports"
    const val EXPORT_DIR_NAME = "exports"
    const val RECORDING_EXTENSION = "m4a"
    const val RECORDING_STAGING_EXTENSION = "m4a.partial"

    const val RECORDING_NOTIFICATION_CHANNEL_ID = "audio_recording"
    const val RECORDING_NOTIFICATION_ID = 4101
    const val RECORDING_CONSENT_VERSION = 1

    const val MINIMUM_STORAGE_RESERVE_BYTES = 512L * 1024L * 1024L
    const val STORAGE_CHECK_INTERVAL_MS = 15_000L
    const val MAXIMUM_IMPORTED_MEDIA_BYTES = 2L * 1024L * 1024L * 1024L
    const val MAXIMUM_IMPORTED_DURATION_MS = 4L * 60L * 60L * 1000L

    const val SAMPLE_RATE_HZ = 16000
    const val BIT_RATE = 64000
    const val CHANNEL_COUNT = 1

    const val CONTAINER_FORMAT = "mpeg4"
    const val CODEC = "aac"
}
