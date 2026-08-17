package com.voice2text.app.privacy

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

internal data class EncryptedAudioApiSecret(
    val initializationVector: ByteArray,
    val ciphertext: ByteArray,
)

internal object AudioApiSecretCipher {
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    fun encrypt(
        plaintext: ByteArray,
        key: SecretKey,
        initializationVector: ByteArray? = null,
    ): EncryptedAudioApiSecret {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        if (initializationVector == null) {
            cipher.init(Cipher.ENCRYPT_MODE, key)
        } else {
            cipher.init(
                Cipher.ENCRYPT_MODE,
                key,
                javax.crypto.spec.GCMParameterSpec(128, initializationVector),
            )
        }
        return EncryptedAudioApiSecret(
            initializationVector = cipher.iv,
            ciphertext = cipher.doFinal(plaintext),
        )
    }

    fun decrypt(
        envelope: EncryptedAudioApiSecret,
        key: SecretKey,
    ): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            key,
            javax.crypto.spec.GCMParameterSpec(128, envelope.initializationVector),
        )
        return cipher.doFinal(envelope.ciphertext)
    }
}

class AudioApiSecretStore(
    context: Context,
) {
    private val preferences =
        context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun set(
        providerId: String,
        secret: String,
    ) {
        val provider = requireProviderId(providerId)
        val normalized = secret.trim()
        require(normalized.isNotEmpty() && normalized.length <= MAX_SECRET_LENGTH) {
            "secret length is invalid"
        }
        val plaintext = normalized.toByteArray(Charsets.UTF_8)
        try {
            val envelope =
                AudioApiSecretCipher.encrypt(
                    plaintext = plaintext,
                    key = getOrCreateKey(provider),
                )
            check(
                preferences
                    .edit()
                    .putString(ivKey(provider), encode(envelope.initializationVector))
                    .putString(ciphertextKey(provider), encode(envelope.ciphertext))
                    .commit(),
            ) {
                "secret storage failed"
            }
        } finally {
            plaintext.fill(0)
        }
    }

    fun get(providerId: String): String? {
        val provider = requireProviderId(providerId)
        val encodedIv = preferences.getString(ivKey(provider), null) ?: return null
        val encodedCiphertext =
            preferences.getString(ciphertextKey(provider), null) ?: return null
        return try {
            val plaintext =
                AudioApiSecretCipher.decrypt(
                    envelope =
                        EncryptedAudioApiSecret(
                            initializationVector = decode(encodedIv),
                            ciphertext = decode(encodedCiphertext),
                        ),
                    key = requireKey(provider),
                )
            try {
                plaintext.toString(Charsets.UTF_8)
            } finally {
                plaintext.fill(0)
            }
        } catch (_: Exception) {
            delete(provider)
            throw AudioApiSecretUnavailableException()
        }
    }

    fun has(providerId: String): Boolean {
        val provider = requireProviderId(providerId)
        return preferences.contains(ivKey(provider)) &&
            preferences.contains(ciphertextKey(provider)) &&
            keyStore().containsAlias(alias(provider))
    }

    fun delete(providerId: String) {
        val provider = requireProviderId(providerId)
        preferences
            .edit()
            .remove(ivKey(provider))
            .remove(ciphertextKey(provider))
            .commit()
        runCatching { keyStore().deleteEntry(alias(provider)) }
    }

    private fun getOrCreateKey(providerId: String): SecretKey {
        val existing = keyStore().getKey(alias(providerId), null) as? SecretKey
        if (existing != null) return existing
        val generator =
            KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                ANDROID_KEYSTORE,
            )
        generator.init(
            KeyGenParameterSpec
                .Builder(
                    alias(providerId),
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun requireKey(providerId: String): SecretKey {
        return keyStore().getKey(alias(providerId), null) as? SecretKey
            ?: throw AudioApiSecretUnavailableException()
    }

    private fun keyStore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun requireProviderId(value: String): String {
        require(PROVIDER_ID.matches(value)) { "provider id is invalid" }
        return value
    }

    private fun alias(providerId: String): String =
        "voice2text.audio_ai.$providerId.v1"

    private fun ivKey(providerId: String): String = "$providerId.iv"

    private fun ciphertextKey(providerId: String): String = "$providerId.ciphertext"

    private fun encode(value: ByteArray): String =
        Base64.encodeToString(value, Base64.NO_WRAP)

    private fun decode(value: String): ByteArray =
        Base64.decode(value, Base64.NO_WRAP)

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val PREFERENCES_NAME = "audio_api_secrets"
        private const val MAX_SECRET_LENGTH = 4096
        private val PROVIDER_ID = Regex("[a-z0-9_-]{1,40}")
    }
}

class AudioApiSecretUnavailableException :
    IllegalStateException("audio API secret is unavailable")
