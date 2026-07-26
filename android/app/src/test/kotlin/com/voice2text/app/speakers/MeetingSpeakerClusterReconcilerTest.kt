package com.voice2text.app.speakers

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MeetingSpeakerClusterReconcilerTest {
    @Test
    fun localSpeakerIndexSwapKeepsMeetingGlobalKeysStable() {
        val reconciler = MeetingSpeakerClusterReconciler(similarityThreshold = 0.8)

        val first = reconciler.reconcile(
            listOf(
                evidence(0, 1.0f, 0.0f),
                evidence(1, 0.0f, 1.0f),
            ),
        )
        val second = reconciler.reconcile(
            listOf(
                evidence(0, 0.0f, 1.0f),
                evidence(1, 1.0f, 0.0f),
            ),
        )

        assertEquals("speaker_1", first.assignmentFor(0).meetingSpeakerKey)
        assertEquals("speaker_2", first.assignmentFor(1).meetingSpeakerKey)
        assertEquals("speaker_2", second.assignmentFor(0).meetingSpeakerKey)
        assertEquals("speaker_1", second.assignmentFor(1).meetingSpeakerKey)
    }

    @Test
    fun oneWindowCannotGreedilyMapTwoClustersToOnePrototype() {
        val reconciler = MeetingSpeakerClusterReconciler(similarityThreshold = 0.8)
        reconciler.reconcile(listOf(evidence(0, 1.0f, 0.0f)))

        val assignments = reconciler.reconcile(
            listOf(
                evidence(0, 1.0f, 0.0f),
                evidence(1, 0.99f, 0.01f),
            ),
        )

        assertEquals("speaker_1", assignments.assignmentFor(0).meetingSpeakerKey)
        assertEquals(SpeakerAssignmentKind.UNKNOWN, assignments.assignmentFor(1).kind)
        assertNull(assignments.assignmentFor(1).meetingSpeakerKey)
        assertEquals(1, reconciler.activePrototypeCount)
    }

    @Test
    fun reliableEmbeddingBelowEveryThresholdCreatesNewAnonymousSpeaker() {
        val reconciler = MeetingSpeakerClusterReconciler(similarityThreshold = 0.8)
        reconciler.reconcile(listOf(evidence(0, 1.0f, 0.0f)))

        val assignment =
            reconciler.reconcile(listOf(evidence(7, 0.0f, 1.0f))).single()

        assertEquals(SpeakerAssignmentKind.ASSIGNED, assignment.kind)
        assertEquals("speaker_2", assignment.meetingSpeakerKey)
        assertTrue(assignment.createdNewPrototype)
    }

    @Test
    fun missingReliableEmbeddingRemainsUnknown() {
        val reconciler = MeetingSpeakerClusterReconciler(similarityThreshold = 0.8)

        val assignment =
            reconciler.reconcile(
                listOf(WindowSpeakerEvidence(localSpeakerIndex = 3, embedding = null)),
            ).single()

        assertEquals(SpeakerAssignmentKind.UNKNOWN, assignment.kind)
        assertNull(assignment.meetingSpeakerKey)
        assertEquals(0, reconciler.activePrototypeCount)
    }

    @Test
    fun closeClearsEphemeralPrototypesAndPreventsReuse() {
        val reconciler = MeetingSpeakerClusterReconciler(similarityThreshold = 0.8)
        reconciler.reconcile(listOf(evidence(0, 1.0f, 0.0f)))

        reconciler.close()

        assertEquals(0, reconciler.activePrototypeCount)
        assertThrows(IllegalStateException::class.java) {
            reconciler.reconcile(listOf(evidence(0, 1.0f, 0.0f)))
        }
    }

    private fun evidence(
        localSpeakerIndex: Int,
        vararg embedding: Float,
    ) = WindowSpeakerEvidence(localSpeakerIndex, embedding)

    private fun List<MeetingSpeakerAssignment>.assignmentFor(
        localSpeakerIndex: Int,
    ): MeetingSpeakerAssignment = single { it.localSpeakerIndex == localSpeakerIndex }
}
