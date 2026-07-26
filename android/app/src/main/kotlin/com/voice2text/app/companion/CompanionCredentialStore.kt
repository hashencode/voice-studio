package com.voice2text.app.companion

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class CompanionCredentialStore(
    context: Context,
) {
    private val preferences =
        context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun put(
        key: String,
        value: ByteArray,
    ) {
        val normalized = requireKey(key)
        require(value.isNotEmpty() && value.size <= MAX_VALUE_BYTES)
        val plaintext = value.copyOf()
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val ciphertext = cipher.doFinal(plaintext)
            check(
                preferences
                    .edit()
                    .putString(ivKey(normalized), encode(cipher.iv))
                    .putString(valueKey(normalized), encode(ciphertext))
                    .commit(),
            ) {
                "companion credential storage failed"
            }
        } finally {
            plaintext.fill(0)
        }
    }

    fun get(key: String): ByteArray? {
        val normalized = requireKey(key)
        val iv = preferences.getString(ivKey(normalized), null) ?: return null
        val ciphertext =
            preferences.getString(valueKey(normalized), null) ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                requireEncryptionKey(),
                GCMParameterSpec(128, decode(iv)),
            )
            cipher.doFinal(decode(ciphertext))
        } catch (_: Exception) {
            delete(normalized)
            throw CompanionCredentialUnavailableException()
        }
    }

    fun delete(key: String) {
        val normalized = requireKey(key)
        preferences
            .edit()
            .remove(ivKey(normalized))
            .remove(valueKey(normalized))
            .commit()
    }

    fun deleteAll() {
        preferences.edit().clear().commit()
        runCatching { keyStore().deleteEntry(KEYSTORE_ALIAS) }
    }

    private fun getOrCreateKey(): SecretKey {
        val existing = keyStore().getKey(KEYSTORE_ALIAS, null) as? SecretKey
        if (existing != null) return existing
        val generator =
            KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                ANDROID_KEYSTORE,
            )
        generator.init(
            KeyGenParameterSpec
                .Builder(
                    KEYSTORE_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun requireEncryptionKey(): SecretKey =
        keyStore().getKey(KEYSTORE_ALIAS, null) as? SecretKey
            ?: throw CompanionCredentialUnavailableException()

    private fun keyStore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun requireKey(value: String): String {
        require(KEY_PATTERN.matches(value)) { "credential key is invalid" }
        return value
    }

    private fun ivKey(key: String): String = "$key.iv"

    private fun valueKey(key: String): String = "$key.value"

    private fun encode(value: ByteArray): String =
        Base64.encodeToString(value, Base64.NO_WRAP)

    private fun decode(value: String): ByteArray =
        Base64.decode(value, Base64.NO_WRAP)

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEYSTORE_ALIAS = "voice2text.companion.credentials.v1"
        private const val PREFERENCES_NAME = "companion_credentials_v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val MAX_VALUE_BYTES = 4096
        private val KEY_PATTERN = Regex("[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}")
    }
}

class CompanionCredentialUnavailableException :
    IllegalStateException("companion credential is unavailable")
