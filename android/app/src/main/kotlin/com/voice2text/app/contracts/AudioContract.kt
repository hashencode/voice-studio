package com.voice2text.app.contracts

object AudioContract {
    const val RECORDER_CHANNEL = "voice2text/recorder"

    const val RECORDING_DIR_NAME = "recordings"
    const val RECORDING_EXTENSION = "m4a"

    const val SAMPLE_RATE_HZ = 16000
    const val BIT_RATE = 64000
    const val CHANNEL_COUNT = 1

    const val CONTAINER_FORMAT = "mpeg4"
    const val CODEC = "aac"
}
