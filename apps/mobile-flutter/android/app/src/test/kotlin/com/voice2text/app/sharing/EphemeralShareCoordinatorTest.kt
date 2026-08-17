package com.voice2text.app.sharing

import java.io.File
import kotlin.io.path.createTempDirectory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EphemeralShareCoordinatorTest {
    @Test
    fun `mime type is limited to supported ephemeral artifacts`() {
        assertEquals("application/zip", ephemeralShareMimeType("bundle.ZIP"))
        assertEquals("application/json", ephemeralShareMimeType("diagnostic.json"))
        assertEquals("text/plain", ephemeralShareMimeType("diagnostic.txt"))
        assertEquals("application/octet-stream", ephemeralShareMimeType("audio.m4a"))
    }

    @Test
    fun `path validation rejects root siblings and traversal`() {
        val parent = createTempDirectory("ephemeral-root-").toFile()
        try {
            val root = File(parent, EPHEMERAL_SHARE_RELATIVE_PATH).apply { mkdirs() }
            val valid = File(root, "bundle.zip").apply { writeText("zip") }
            val sibling = File(root.parentFile, "sibling.zip").apply { writeText("zip") }
            val traversal = File(root, "../sibling.zip")

            assertTrue(isWithinEphemeralShareRoot(valid, root))
            assertFalse(isWithinEphemeralShareRoot(root, root))
            assertFalse(isWithinEphemeralShareRoot(sibling, root))
            assertFalse(isWithinEphemeralShareRoot(traversal, root))
        } finally {
            parent.deleteRecursively()
        }
    }

    @Test
    fun `stale cleanup predicate only accepts direct expired children`() {
        val parent = createTempDirectory("ephemeral-stale-").toFile()
        try {
            val root = File(parent, EPHEMERAL_SHARE_RELATIVE_PATH).apply { mkdirs() }
            val stale = File(root, "stale.zip").apply {
                writeText("zip")
                setLastModified(100)
            }
            val fresh = File(root, "fresh.zip").apply {
                writeText("zip")
                setLastModified(300)
            }
            val nested = File(root, "nested/stale.zip").apply {
                parentFile?.mkdirs()
                writeText("zip")
                setLastModified(100)
            }

            assertTrue(isStaleEphemeralChild(stale, root, 200))
            assertFalse(isStaleEphemeralChild(fresh, root, 200))
            assertFalse(isStaleEphemeralChild(nested, root, 200))
        } finally {
            parent.deleteRecursively()
        }
    }
}
