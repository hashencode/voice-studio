package com.voice2text.app.importing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedMediaRequestQueueTest {
    @Test
    fun preservesOrderAndSuppressesOnlyPendingDuplicates() {
        val queue = SharedMediaRequestQueue()

        assertTrue(queue.offer("content://media/audio/1"))
        assertFalse(queue.offer("content://media/audio/1"))
        assertTrue(queue.offer("content://media/video/2"))
        assertEquals("content://media/audio/1", queue.poll())
        assertTrue(queue.offer("content://media/audio/1"))
        assertEquals("content://media/video/2", queue.poll())
        assertEquals("content://media/audio/1", queue.poll())
        assertNull(queue.poll())
    }

    @Test
    fun rejectsNewRequestsWhenTheBoundedQueueIsFull() {
        val queue = SharedMediaRequestQueue(capacity = 2)

        assertTrue(queue.offer("content://media/audio/1"))
        assertTrue(queue.offer("content://media/audio/2"))
        assertFalse(queue.offer("content://media/audio/3"))
        assertTrue(queue.hasPending())
    }
}
