package com.voice2text.app.privacy

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MeetingApiSecretStoreSmokeTest {
    @Test
    fun keystoreRoundTripAndDelete() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = MeetingApiSecretStore(context)
        val providerId = "instrumented_test"
        val secret = "test-only-secret-${System.nanoTime()}"
        store.delete(providerId)

        store.set(providerId, secret)
        assertTrue(store.has(providerId))
        assertEquals(secret, store.get(providerId))

        val preferences =
            context.getSharedPreferences("meeting_api_secrets", 0).all.values
        assertFalse(preferences.any { value -> value == secret })

        store.delete(providerId)
        assertFalse(store.has(providerId))
        assertNull(store.get(providerId))
    }
}
