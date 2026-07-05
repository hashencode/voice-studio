package com.voice2text.app.realtime

class RealtimeDegradationPolicy(
    private val maxQueuedSegments: Int = 2,
) {
    fun shouldDropSegment(queuedSegments: Int): Boolean {
        return queuedSegments >= maxQueuedSegments
    }
}
