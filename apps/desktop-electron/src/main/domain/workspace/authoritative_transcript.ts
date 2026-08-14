import { z } from "zod";

const maximumSegments = 200_000;
const segmentSchema = z
  .object({
    startSeconds: z.number().finite().nonnegative(),
    endSeconds: z.number().finite().positive(),
    text: z.string().trim().min(1).max(1_000_000),
    speakerAssignment: z.enum(["anonymous", "overlap", "unknown"]),
    anonymousSpeakerKey: z.string().min(1).max(256).nullable().optional(),
  })
  .passthrough();
const publicationSchema = z
  .object({
    segments: z.array(segmentSchema).min(1).max(maximumSegments),
    diarizationSucceeded: z.boolean(),
  })
  .passthrough();

export interface AuthoritativeSegment {
  stableKey: string;
  sequenceId: number;
  startMs: number;
  endMs: number;
  text: string;
  speakerState: "assigned" | "overlap" | "unknown";
  speakerKey: string | null;
}

export interface AuthoritativeTranscript {
  partialSuccess: boolean;
  segments: AuthoritativeSegment[];
}

export function parseAuthoritativeTranscript(
  payload: Record<string, unknown>,
): AuthoritativeTranscript | null {
  const parsed = publicationSchema.safeParse(payload);
  if (!parsed.success) return null;
  const segments = parsed.data.segments.map((segment, sequenceId) => {
    const startMs = Math.round(segment.startSeconds * 1_000);
    const endMs = Math.round(segment.endSeconds * 1_000);
    if (endMs <= startMs) {
      throw new Error(
        "authoritative transcript segment has an invalid time range",
      );
    }
    const speakerKey = segment.anonymousSpeakerKey ?? null;
    if ((segment.speakerAssignment === "anonymous") !== (speakerKey !== null)) {
      throw new Error(
        "authoritative transcript speaker identity is inconsistent",
      );
    }
    return {
      stableKey: `${sequenceId}:${startMs}:${endMs}`,
      sequenceId,
      startMs,
      endMs,
      text: segment.text,
      speakerState:
        segment.speakerAssignment === "anonymous"
          ? ("assigned" as const)
          : segment.speakerAssignment,
      speakerKey,
    };
  });
  return { partialSuccess: !parsed.data.diarizationSucceeded, segments };
}
