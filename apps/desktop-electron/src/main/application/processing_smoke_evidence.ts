import { createHash } from "node:crypto";

export interface ProcessingSmokeReferenceBindings {
  dartSources: Array<{ path: string; sha256: string }>;
  fixtureSha256: string;
}

export interface ProcessingSmokeProjection {
  schemaVersion: 1;
  referenceBindings: ProcessingSmokeReferenceBindings;
  resource: {
    manifestSha256: string;
    modelSha256: string;
    runtimeSha256: string;
  };
  media: {
    sourceSha256: string;
    normalizedSha256: string;
    normalizedSizeBytes: number;
    durationMs: number;
  };
  databaseProjectionSha256: string;
  resultProjectionSha256: string;
  state: string;
  phase: string;
  attempt: number;
  progressFraction: number;
  transcriptNonEmpty: boolean;
  segmentCount: number;
}

export interface ProcessingSmokeEvidence {
  schemaVersion: 1;
  projection: ProcessingSmokeProjection;
  projectionSha256: string;
  transcriptNonEmpty: boolean;
  segmentCount: number;
}

export function parseProcessingSmokeReferenceBindings(
  raw: string,
): ProcessingSmokeReferenceBindings {
  if (Buffer.byteLength(raw, "utf8") > 8_192) {
    throw new Error("processing smoke reference bindings are too large");
  }
  const parsed = JSON.parse(raw) as Partial<ProcessingSmokeReferenceBindings>;
  if (
    !isSha256(parsed.fixtureSha256) ||
    !Array.isArray(parsed.dartSources) ||
    parsed.dartSources.length === 0 ||
    parsed.dartSources.length > 16
  ) {
    throw new Error("processing smoke reference bindings are invalid");
  }
  const seen = new Set<string>();
  const dartSources = parsed.dartSources.map((source) => {
    if (
      !source ||
      typeof source.path !== "string" ||
      source.path.length === 0 ||
      source.path.length > 256 ||
      source.path.startsWith("/") ||
      source.path.includes("..") ||
      source.path.includes("\\") ||
      seen.has(source.path) ||
      !isSha256(source.sha256)
    ) {
      throw new Error("processing smoke Dart source binding is invalid");
    }
    seen.add(source.path);
    return { path: source.path, sha256: source.sha256 };
  });
  return {
    fixtureSha256: parsed.fixtureSha256,
    dartSources: dartSources.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

export function buildProcessingSmokeEvidence(input: {
  referenceBindings: ProcessingSmokeReferenceBindings;
  resource: ProcessingSmokeProjection["resource"];
  media: ProcessingSmokeProjection["media"];
  databaseProjection: Record<string, unknown>;
  resultPayload: Record<string, unknown>;
  state: string;
  phase: string;
  attempt: number;
  progressFraction: number;
}): ProcessingSmokeEvidence {
  const segments = Array.isArray(input.resultPayload.segments)
    ? input.resultPayload.segments
    : [];
  const transcriptNonEmpty = segments.some(
    (segment) =>
      isRecord(segment) &&
      typeof segment.text === "string" &&
      segment.text.trim().length > 0,
  );
  const stableResult = { ...input.resultPayload };
  delete stableResult.elapsedMilliseconds;
  delete stableResult.peakResidentBytes;
  const projection: ProcessingSmokeProjection = {
    schemaVersion: 1,
    referenceBindings: input.referenceBindings,
    resource: input.resource,
    media: input.media,
    databaseProjectionSha256: sha256Canonical(input.databaseProjection),
    resultProjectionSha256: sha256Canonical(stableResult),
    state: input.state,
    phase: input.phase,
    attempt: input.attempt,
    progressFraction: input.progressFraction,
    transcriptNonEmpty,
    segmentCount: segments.length,
  };
  return {
    schemaVersion: 1,
    projection,
    projectionSha256: sha256Canonical(projection),
    transcriptNonEmpty,
    segmentCount: segments.length,
  };
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
