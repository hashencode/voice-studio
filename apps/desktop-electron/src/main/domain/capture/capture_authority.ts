import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { sha256Schema } from "../../../shared/contracts";

const trackSchema = z
  .object({
    kind: z.enum(["system_audio", "microphone"]),
    healthy: z.boolean(),
    sampleRate: z.number().positive().finite(),
    channels: z.number().int().min(1).max(32),
    format: z.string().min(1).max(64),
  })
  .strict();
const chunkSchema = z
  .object({
    track: z.enum(["system_audio", "microphone"]),
    sequence: z.number().int().nonnegative().max(100_000),
    startMs: z.number().int().nonnegative().safe(),
    endMs: z.number().int().nonnegative().safe(),
    relativePath: z
      .string()
      .regex(/^(system|microphone)\/chunk-[0-9]{6}\.caf$/),
    bytes: z.number().int().positive().safe(),
    sha256: sha256Schema,
    finalized: z.literal(true),
  })
  .strict();
const eventSchema = z
  .object({
    sequence: z.number().int().nonnegative().max(100_000),
    monotonicMs: z.number().int().nonnegative().safe(),
    kind: z.string().min(1).max(80),
    track: z.string().min(1).max(40),
    reason: z.string().min(1).max(240),
  })
  .strict();
const journalSchema = z
  .object({
    schema: z.literal("desktop-capture-session/v1"),
    sessionId: z.string().regex(/^session-[a-zA-Z0-9-]{12,120}$/),
    captureMode: z.enum(["dual_track", "microphone_only", "system_audio_only"]),
    tracks: z.array(trackSchema).min(1).max(2),
    chunks: z.array(chunkSchema).max(100_000),
    events: z.array(eventSchema).max(100_000),
  })
  .passthrough();

export type CaptureAuthority = z.infer<typeof journalSchema>;

export async function validateCaptureAuthority(options: {
  captureRoot: string;
  sessionId: string;
  expectedJournalSha256: string;
  afterPinnedOpenForTesting?: (
    kind: "journal" | "chunk",
    filePath: string,
  ) => void | Promise<void>;
}): Promise<CaptureAuthority> {
  const root = await realpath(options.captureRoot);
  const session = path.join(root, options.sessionId);
  if (path.dirname(session) !== root)
    throw new Error("capture session escaped its root");
  const rootHandle = await openDirectory(root);
  const sessionHandle = await openDirectory(session);
  try {
    await assertPathIdentity(root, rootHandle, "capture root");
    await assertPathIdentity(session, sessionHandle, "capture session root");
    const journalPath = path.join(session, "journal.json");
    const journalRead = await readPinnedRegularFile({
      filePath: journalPath,
      maximumBytes: 64 * 1024 * 1024,
      expectedBytes: undefined,
      parentPath: session,
      parentHandle: sessionHandle,
      collect: true,
      afterOpen: () =>
        options.afterPinnedOpenForTesting?.("journal", journalPath),
    });
    if (journalRead.sha256 !== options.expectedJournalSha256) {
      throw new Error("capture journal hash mismatch");
    }
    const journal = journalSchema.parse(
      JSON.parse(journalRead.data!.toString("utf8")),
    );
    if (journal.sessionId !== options.sessionId) {
      throw new Error("capture journal session mismatch");
    }
    const trackKinds = new Set(journal.tracks.map((track) => track.kind));
    if (
      journal.captureMode === "microphone_only" &&
      !trackKinds.has("microphone")
    ) {
      throw new Error("microphone authority is missing");
    }
    if (
      journal.captureMode === "system_audio_only" &&
      !trackKinds.has("system_audio")
    ) {
      throw new Error("system audio authority is missing");
    }
    if (
      journal.captureMode === "dual_track" &&
      (!trackKinds.has("microphone") || !trackKinds.has("system_audio"))
    ) {
      throw new Error("system audio authority is missing");
    }
    const paths = new Set<string>();
    const identities = new Set<string>();
    for (const chunk of journal.chunks) {
      if (!trackKinds.has(chunk.track) || chunk.endMs < chunk.startMs) {
        throw new Error("capture chunk metadata is invalid");
      }
      const identity = `${chunk.track}:${chunk.sequence}`;
      if (!identities.add(identity) || !paths.add(chunk.relativePath)) {
        throw new Error("capture chunk identity is duplicated");
      }
      const chunkPath = path.join(session, chunk.relativePath);
      if (!chunkPath.startsWith(`${session}${path.sep}`)) {
        throw new Error("capture chunk escaped its session");
      }
      const chunkRead = await readPinnedRegularFile({
        filePath: chunkPath,
        maximumBytes: chunk.bytes,
        expectedBytes: chunk.bytes,
        parentPath: session,
        parentHandle: sessionHandle,
        collect: false,
        afterOpen: () =>
          options.afterPinnedOpenForTesting?.("chunk", chunkPath),
      });
      if (chunkRead.sha256 !== chunk.sha256) {
        throw new Error("capture chunk hash mismatch");
      }
    }
    await assertPathIdentity(root, rootHandle, "capture root");
    await assertPathIdentity(session, sessionHandle, "capture session root");
    return journal;
  } finally {
    await sessionHandle.close();
    await rootHandle.close();
  }
}

async function openDirectory(directoryPath: string): Promise<FileHandle> {
  return await open(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
}

async function assertPathIdentity(
  filePath: string,
  handle: FileHandle,
  label: string,
): Promise<void> {
  const [pinned, current] = await Promise.all([handle.stat(), lstat(filePath)]);
  if (
    !pinned.isDirectory() ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    pinned.dev !== current.dev ||
    pinned.ino !== current.ino
  ) {
    throw new Error(`${label} was replaced`);
  }
}

async function readPinnedRegularFile(options: {
  filePath: string;
  maximumBytes: number;
  expectedBytes: number | undefined;
  parentPath: string;
  parentHandle: FileHandle;
  collect: boolean;
  afterOpen: () => void | Promise<void> | undefined;
}): Promise<{ sha256: string; data?: Buffer }> {
  await assertPathIdentity(
    options.parentPath,
    options.parentHandle,
    "capture session root",
  );
  const handle = await open(
    options.filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => {
    throw new Error("capture authority is not a bounded regular file");
  });
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 0 ||
      before.size > options.maximumBytes ||
      (options.expectedBytes !== undefined &&
        before.size !== options.expectedBytes) ||
      (before.size > 0 && before.blocks * 512 < before.size)
    ) {
      throw new Error("capture authority is not a bounded regular file");
    }
    await options.afterOpen();
    const hasher = createHash("sha256");
    const collected: Buffer[] = [];
    let offset = 0;
    while (offset < before.size) {
      const buffer = Buffer.allocUnsafe(
        Math.min(1024 * 1024, before.size - offset),
      );
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        offset,
      );
      if (bytesRead === 0) break;
      const bytes = buffer.subarray(0, bytesRead);
      hasher.update(bytes);
      if (options.collect) collected.push(Buffer.from(bytes));
      offset += bytesRead;
    }
    const [after, current] = await Promise.all([
      handle.stat(),
      lstat(options.filePath).catch(() => null),
    ]);
    if (
      offset !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      !current ||
      current.isSymbolicLink() ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    ) {
      throw new Error("capture authority was replaced while hashing");
    }
    await assertPathIdentity(
      options.parentPath,
      options.parentHandle,
      "capture session root",
    );
    return {
      sha256: hasher.digest("hex"),
      data: options.collect ? Buffer.concat(collected, before.size) : undefined,
    };
  } finally {
    await handle.close();
  }
}
