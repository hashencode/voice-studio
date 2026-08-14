import type {
  ExportMeetingResponse,
  MeetingExportFormat,
  MeetingSegment,
  MeetingWorkspaceSnapshot,
} from "../../../shared/contracts";
import { MeetingWorkspaceService } from "./meeting_workspace_service";

export interface ExportWriteRequest {
  suggestedName: string;
  extension: MeetingExportFormat;
  mimeType: string;
  contents: string;
}

export type MeetingExportDestination = (
  request: ExportWriteRequest,
) => Promise<ExportMeetingResponse>;

export class MeetingExportService {
  constructor(
    private readonly workspace: MeetingWorkspaceService,
    private readonly destination: MeetingExportDestination,
  ) {}

  async exportMeeting(
    meetingId: number,
    format: MeetingExportFormat,
  ): Promise<ExportMeetingResponse> {
    const snapshot = this.workspace.openMeeting(meetingId);
    if (!snapshot?.summary.generationId) {
      throw new Error(
        "meeting has no complete authoritative transcript to export",
      );
    }
    const base = safeFilenameBase(snapshot.summary.displayName);
    const output = render(snapshot, format);
    return await this.destination({
      suggestedName: `${base}.${format}`,
      extension: format,
      mimeType: mimeType(format),
      contents: output,
    });
  }
}

export function safeFilenameBase(value: string): string {
  const safe = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === "/" ||
        character === "\\" ||
        character === ":" ||
        code < 32
        ? "_"
        : character;
    })
    .join("")
    .trim();
  if (safe.length === 0) return "meeting";
  let output = "";
  for (const character of safe) {
    if (Buffer.byteLength(output + character, "utf8") > 240) break;
    output += character;
  }
  return output || "meeting";
}

function render(
  snapshot: MeetingWorkspaceSnapshot,
  format: MeetingExportFormat,
): string {
  switch (format) {
    case "txt":
      return snapshot.segments
        .map((segment) => `${speaker(segment)}：${segment.text}`)
        .join("\n");
    case "md":
      return `# ${snapshot.summary.displayName}\n\n${snapshot.segments
        .map(
          (segment) =>
            `- **${speaker(segment)} · ${clock(segment.startMs)}** ${segment.text}`,
        )
        .join("\n")}\n`;
    case "vtt":
      return timed(snapshot, true);
    case "srt":
      return timed(snapshot, false);
    case "json":
      return `${JSON.stringify(
        {
          schemaVersion: 1,
          meeting: {
            id: snapshot.summary.meetingId,
            displayName: snapshot.summary.displayName,
            durationMs: snapshot.summary.durationMs,
            generationId: snapshot.summary.generationId,
            generationKind: snapshot.summary.generationKind,
          },
          segments: snapshot.segments.map((segment) => ({
            id: segment.id,
            sequenceId: segment.sequenceId,
            startMs: segment.startMs,
            endMs: segment.endMs,
            text: segment.text,
            machineText: segment.machineText,
            reviewState: segment.reviewState,
            speakerState: segment.speakerState,
            speakerId: segment.speakerId,
            speakerName: segment.speakerName,
            speakerSource: segment.speakerSource,
          })),
        },
        null,
        2,
      )}\n`;
  }
}

function timed(snapshot: MeetingWorkspaceSnapshot, webVtt: boolean): string {
  const cues = snapshot.segments.map(
    (segment, index) =>
      `${index + 1}\n${timestamp(segment.startMs, webVtt)} --> ${timestamp(segment.endMs, webVtt)}\n<v ${speaker(segment)}>${segment.text}\n`,
  );
  return `${webVtt ? "WEBVTT\n\n" : ""}${cues.join("\n")}`;
}

function speaker(segment: MeetingSegment): string {
  if (segment.speakerState === "overlap") return "多人重叠";
  if (segment.speakerState === "unknown") return "未知说话人";
  return segment.speakerName ?? "匿名说话人";
}

function clock(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(remainder)}`
    : `${pad(minutes)}:${pad(remainder)}`;
}

function timestamp(milliseconds: number, webVtt: boolean): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${webVtt ? "." : ","}${String(millis).padStart(3, "0")}`;
}

function mimeType(format: MeetingExportFormat): string {
  return {
    txt: "text/plain",
    md: "text/markdown",
    vtt: "text/vtt",
    srt: "application/x-subrip",
    json: "application/json",
  }[format];
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
