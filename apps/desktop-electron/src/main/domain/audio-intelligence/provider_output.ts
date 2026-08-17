import { z } from "zod";

import { AiProviderFailure } from "./provider_security";

export interface AudioAiInputSegment {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
  speakerState?: string;
}

const evidenceSchema = z
  .object({
    segment_id: z.number().int().positive(),
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().positive(),
  })
  .strict();

const wireOutputSchema = z
  .object({
    schema_version: z.literal("audio_intelligence_output/v1"),
    suggested_title: z.string().trim().min(1).max(512).nullable(),
    audio_type: z.string().trim().min(1).max(128).nullable(),
    items: z
      .array(
        z
          .object({
            kind: z.string().trim().min(1).max(128),
            body: z.string().trim().min(1).max(4_000),
            evidence: z.array(evidenceSchema).min(1).max(20),
            action_owner: z.string().trim().min(1).max(512).nullable(),
            action_due_at_ms: z.number().int().nonnegative().nullable(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export interface AudioAiOutput {
  schemaVersion: "audio_intelligence_output/v1";
  suggestedTitle: string | null;
  audioType: string | null;
  items: Array<{
    kind: string;
    body: string;
    evidence: Array<{ segmentId: number; startMs: number; endMs: number }>;
    actionOwner: string | null;
    actionDueAtMs: number | null;
  }>;
}

export function decodeAudioAiOutput(
  source: string,
  inputSegments: readonly AudioAiInputSegment[],
): AudioAiOutput {
  let wire: z.infer<typeof wireOutputSchema>;
  try {
    wire = wireOutputSchema.parse(JSON.parse(source));
  } catch (error) {
    throw new AiProviderFailure(
      "AI_INVALID_OUTPUT",
      "AI output schema is invalid",
      {
        cause: error,
      },
    );
  }
  const segments = new Map(
    inputSegments.map((segment) => [segment.id, segment]),
  );
  for (const item of wire.items) {
    for (const evidence of item.evidence) {
      const segment = segments.get(evidence.segment_id);
      if (
        !segment ||
        segment.startMs !== evidence.start_ms ||
        segment.endMs !== evidence.end_ms
      ) {
        throw new AiProviderFailure(
          "AI_EVIDENCE_INVALID",
          "AI output cites evidence outside the authorized transcript scope",
        );
      }
    }
  }
  return {
    schemaVersion: wire.schema_version,
    suggestedTitle: wire.suggested_title,
    audioType: wire.audio_type,
    items: wire.items.map((item) => ({
      kind: item.kind,
      body: item.body,
      evidence: item.evidence.map((evidence) => ({
        segmentId: evidence.segment_id,
        startMs: evidence.start_ms,
        endMs: evidence.end_ms,
      })),
      actionOwner: item.action_owner,
      actionDueAtMs: item.action_due_at_ms,
    })),
  };
}
