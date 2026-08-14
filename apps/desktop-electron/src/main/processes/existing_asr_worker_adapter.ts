import { z } from "zod";

import { sha256Schema } from "../../shared/contracts";
import type { ExecutionIntent } from "../domain/models";

const existingFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal("progress"),
      phase: z.enum(["asr", "diarization"]),
      fraction: z.number().min(0).max(1),
    })
    .passthrough(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal("result"),
      phase: z.enum(["asr", "diarization"]),
      sourceSha256: sha256Schema,
    })
    .passthrough(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal("error"),
      code: z.string().min(1).max(128),
    })
    .passthrough(),
]);

const maximumSegments = 200_000;
const maximumDurationSeconds = 4 * 60 * 60;
const asrResultSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(4 * 1024 * 1024),
    asrResultVersion: z.literal(2).optional(),
    segments: z
      .array(z.string().max(1024 * 1024))
      .max(maximumSegments)
      .optional(),
    segmentStartSeconds: z
      .array(z.number().finite().nonnegative())
      .max(maximumSegments)
      .optional(),
    durationSeconds: z.number().finite().positive().max(maximumDurationSeconds),
    residentBytes: z.number().int().nonnegative().optional(),
  })
  .passthrough();
const diarizationResultSchema = z
  .object({
    turns: z
      .array(
        z
          .object({
            startSeconds: z.number().finite().nonnegative(),
            endSeconds: z.number().finite().positive(),
            speakerKey: z.string().min(1).max(256),
          })
          .strict(),
      )
      .max(maximumSegments),
    residentBytes: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export function adaptExistingAsrWorkerFrame(
  raw: unknown,
  intent: ExecutionIntent,
): Record<string, unknown> {
  const frame = existingFrameSchema.parse(raw);
  if (frame.type !== "error" && frame.phase !== intent.phase) {
    throw new Error("existing worker frame failed the phase fence");
  }
  if (frame.type === "result" && frame.sourceSha256 !== intent.sourceSha256) {
    throw new Error("existing worker result failed the source hash fence");
  }
  const fence = {
    schemaVersion: 1,
    operationId: intent.operationId,
    attempt: intent.attempt,
    sourceIdentity: intent.sourceIdentity,
    phase: intent.phase,
    protocolIdentity: intent.protocolIdentity,
    sourceSha256: intent.sourceSha256,
    modelSha256: intent.modelSha256,
    runtimeSha256: intent.runtimeSha256,
  };
  if (frame.type === "progress") {
    return { ...fence, type: "progress", fraction: frame.fraction };
  }
  if (frame.type === "error") {
    return { ...fence, type: "error", code: frame.code };
  }
  const payload = { ...frame } as Record<string, unknown>;
  delete payload.schemaVersion;
  delete payload.type;
  return { ...fence, type: "result", payload };
}

export function finalizeExistingSherpaResult(
  rawAsr: Record<string, unknown>,
  rawDiarization: Record<string, unknown> | null,
  diarizationErrorCode: "DIARIZATION_FAILED" | null = null,
  elapsedMilliseconds = 0,
): Record<string, unknown> {
  const asr = asrResultSchema.parse(rawAsr);
  const diarization = rawDiarization
    ? diarizationResultSchema.parse(rawDiarization)
    : null;
  if ((diarization === null) !== (diarizationErrorCode !== null)) {
    throw new Error("diarization result and error disposition disagree");
  }
  for (const turn of diarization?.turns ?? []) {
    if (
      turn.startSeconds >= turn.endSeconds ||
      turn.endSeconds > asr.durationSeconds
    ) {
      throw new Error("diarization turn exceeds the media time envelope");
    }
  }
  const units = asr.segments;
  const starts = asr.segmentStartSeconds;
  const transcriptSegments =
    units && starts && units.length > 0 && units.length === starts.length
      ? mergeTranscriptSegments(units, starts, asr.durationSeconds, diarization)
      : [
          {
            startSeconds: 0,
            endSeconds: asr.durationSeconds,
            text: asr.text,
            speakerAssignment: "unknown",
            anonymousSpeakerKey: null,
          },
        ];
  if (
    transcriptSegments.length === 0 ||
    transcriptSegments.length > maximumSegments
  ) {
    throw new Error("processing result exceeded the segment envelope");
  }
  return {
    segments: transcriptSegments,
    engineId: "sherpa-onnx-1.13.4/qwen3-asr-0.6b-int8-pyannote3",
    elapsedMilliseconds: Math.max(0, Math.trunc(elapsedMilliseconds)),
    peakResidentBytes: Math.max(
      asr.residentBytes ?? 0,
      diarization?.residentBytes ?? 0,
    ),
    diarizationSucceeded: diarization !== null,
    diarizationErrorCode,
  };
}

function mergeTranscriptSegments(
  units: string[],
  starts: number[],
  durationSeconds: number,
  diarization: z.infer<typeof diarizationResultSchema> | null,
): Array<Record<string, unknown>> {
  const turns = [...(diarization?.turns ?? [])].sort(
    (left, right) =>
      left.startSeconds - right.startSeconds ||
      left.endSeconds - right.endSeconds,
  );
  let firstPossibleTurn = 0;
  return units.map((text, index) => {
    const start = starts[index]!;
    const next = starts[index + 1] ?? durationSeconds;
    if (start >= durationSeconds || next > durationSeconds || next < start) {
      throw new Error("ASR segment timestamps are not monotonic");
    }
    const end = Math.max(start + 0.001, Math.min(durationSeconds, next));
    while (
      firstPossibleTurn < turns.length &&
      turns[firstPossibleTurn]!.endSeconds <= start
    ) {
      firstPossibleTurn += 1;
    }
    const active = [] as typeof turns;
    for (
      let turnIndex = firstPossibleTurn;
      turnIndex < turns.length;
      turnIndex += 1
    ) {
      const turn = turns[turnIndex]!;
      if (turn.startSeconds >= end) break;
      if (turn.endSeconds > start) active.push(turn);
    }
    const speakers = new Set(active.map((turn) => turn.speakerKey));
    const overlap = hasConcurrentSpeakers(active, start, end);
    return {
      startSeconds: Math.min(durationSeconds, Math.max(0, start)),
      endSeconds: end,
      text,
      speakerAssignment: overlap
        ? "overlap"
        : speakers.size === 1
          ? "anonymous"
          : "unknown",
      anonymousSpeakerKey: speakers.size === 1 ? [...speakers][0]! : null,
    };
  });
}

function hasConcurrentSpeakers(
  turns: Array<{
    startSeconds: number;
    endSeconds: number;
    speakerKey: string;
  }>,
  start: number,
  end: number,
): boolean {
  for (let leftIndex = 0; leftIndex < turns.length; leftIndex += 1) {
    const left = turns[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < turns.length;
      rightIndex += 1
    ) {
      const right = turns[rightIndex]!;
      if (left.speakerKey === right.speakerKey) continue;
      if (
        Math.min(end, left.endSeconds, right.endSeconds) >
        Math.max(start, left.startSeconds, right.startSeconds)
      ) {
        return true;
      }
    }
  }
  return false;
}
