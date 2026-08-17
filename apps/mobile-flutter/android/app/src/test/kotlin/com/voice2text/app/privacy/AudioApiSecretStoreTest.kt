package com.voice2text.app.privacy

import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class AudioApiSecretStoreTest {
    @Test
    fun `cipher round trip does not retain plaintext bytes`() {
        val key =
            SecretKeySpec(
                ByteArray(32) { index -> (index + 1).toByte() },
                "AES",
            )
        val plaintext = "test-only-secret".toByteArray()
        val envelope =
            AudioApiSecretCipher.encrypt(
                plaintext = plaintext,
                key = key,
                initializationVector = ByteArray(12) { index -> index.toByte() },
            )

        assertArrayEquals(
            plaintext,
            AudioApiSecretCipher.decrypt(envelope, key),
        )
        assertFalse(envelope.ciphertext.contentEquals(plaintext))
    }
}
