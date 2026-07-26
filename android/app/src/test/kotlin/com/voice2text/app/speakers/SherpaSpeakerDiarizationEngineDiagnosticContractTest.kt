package com.voice2text.app.speakers

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class SherpaSpeakerDiarizationEngineDiagnosticContractTest {
    @Test
    fun fullFixtureDiagnosticSurfaceIsExplicitAndBenchmarkOnly() {
        val method =
            SherpaSpeakerDiarizationEngine::class.java.declaredMethods.singleOrNull {
                it.name == "processFullFixtureForDiagnostic"
            }

        assertNotNull(
            "official parity needs an explicit full-fixture process surface",
            method,
        )
        assertEquals(
            listOf(FloatArray::class.java, Int::class.javaPrimitiveType),
            method!!.parameterTypes.toList(),
        )
    }
}
