import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  assertPathIdentity,
  openDirectory,
  validateCaptureAuthority,
} from "../capture/capture_authority";
import type { AudioProfilePaths } from "../../profile/profile_paths";
import type { FormalCaptureMedia } from "./formal_transcript_handoff_service";

const MAXIMUM_SPOOL_BYTES = 4 * 60 * 60 * 16_000 * 2;
const PCM_FRAME_BYTES = 3_200;

export async function prepareFormalCaptureMedia(options: {
  profile: AudioProfilePaths;
  sessionId: string;
  recordingSha256: string;
  journalSha256: string;
}): Promise<FormalCaptureMedia> {
  if (
    !/^session-[a-zA-Z0-9-]{12,120}$/.test(options.sessionId) ||
    !/^[a-f0-9]{64}$/.test(options.recordingSha256) ||
    !/^[a-f0-9]{64}$/.test(options.journalSha256)
  ) {
    throw new Error("formal capture identity is invalid");
  }
  const captureRoot = await realpath(options.profile.captureDirectory);
  const sessionRoot = path.join(captureRoot, options.sessionId);
  const captionRoot = path.join(sessionRoot, "caption");
  const [captureHandle, sessionHandle, captionHandle, mediaHandle] =
    await Promise.all([
      openDirectory(captureRoot),
      openDirectory(sessionRoot),
      openDirectory(captionRoot),
      openDirectory(options.profile.mediaDirectory),
    ]);
  const finalName = `capture-${options.sessionId}.wav`;
  const temporaryName = `.${finalName}.tmp-${process.pid}`;
  const finalPath = path.join(options.profile.mediaDirectory, finalName);
  const temporaryPath = path.join(
    options.profile.mediaDirectory,
    temporaryName,
  );
  let temporaryCreated = false;
  try {
    await assertPathIdentity(captureRoot, captureHandle, "capture root");
    await assertPathIdentity(
      sessionRoot,
      sessionHandle,
      "capture session root",
    );
    await assertPathIdentity(
      captionRoot,
      captionHandle,
      "capture caption root",
    );
    await assertPathIdentity(
      options.profile.mediaDirectory,
      mediaHandle,
      "profile media root",
    );
    const authority = await validateCaptureAuthority({
      captureRoot,
      sessionId: options.sessionId,
      expectedJournalSha256: options.journalSha256,
    });
    const spoolAuthority = authority.spool;
    const authorityGapCount = authority.events.filter((event) =>
      ["track_gap", "device_changed", "encoder_failed"].includes(event.kind),
    ).length;
    if (
      options.recordingSha256 !== options.journalSha256 ||
      !spoolAuthority ||
      !("complete" in spoolAuthority) ||
      spoolAuthority.complete !== true ||
      !["completed", "partial_capture"].includes(authority.state ?? "") ||
      spoolAuthority.captureTimelineMs !== authority.captureTimelineMs ||
      spoolAuthority.gapCount !== authorityGapCount ||
      spoolAuthority.durationMs !== spoolAuthority.bytes / 32
    ) {
      throw new Error("caption spool lacks finalized journal authority");
    }
    const sourcePath = path.join(captionRoot, "live-caption.pcmspool");
    const source = await open(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await assertPathIdentity(
        captionRoot,
        captionHandle,
        "capture caption root",
      );
      const before = await source.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size <= 0 ||
        before.size > MAXIMUM_SPOOL_BYTES ||
        before.size !== spoolAuthority.bytes ||
        before.size % PCM_FRAME_BYTES !== 0 ||
        before.blocks * 512 < before.size
      ) {
        throw new Error("caption spool is not a bounded regular PCM file");
      }
      const finalExists = await lstat(finalPath).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      const destination = finalExists
        ? null
        : await open(
            temporaryPath,
            constants.O_CREAT |
              constants.O_EXCL |
              constants.O_RDWR |
              constants.O_NOFOLLOW,
            0o600,
          );
      temporaryCreated = destination !== null;
      try {
        await assertPathIdentity(
          options.profile.mediaDirectory,
          mediaHandle,
          "profile media root",
        );
        const sourceHash = createHash("sha256");
        const outputHash = createHash("sha256");
        const header = wavHeader(before.size);
        outputHash.update(header);
        if (destination) await destination.write(header, 0, header.length, 0);
        let offset = 0;
        while (offset < before.size) {
          const buffer = Buffer.allocUnsafe(
            Math.min(1024 * 1024, before.size - offset),
          );
          const { bytesRead } = await source.read(
            buffer,
            0,
            buffer.length,
            offset,
          );
          if (bytesRead === 0) break;
          const bytes = buffer.subarray(0, bytesRead);
          sourceHash.update(bytes);
          outputHash.update(bytes);
          if (destination) {
            await destination.write(bytes, 0, bytesRead, 44 + offset);
          }
          offset += bytesRead;
        }
        const after = await source.stat();
        if (
          offset !== before.size ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        ) {
          throw new Error("caption spool changed during formal handoff");
        }
        const spoolSha256 = sourceHash.digest("hex");
        if (spoolSha256 !== spoolAuthority.sha256) {
          throw new Error(
            "caption spool hash mismatched its journal authority",
          );
        }
        const normalizedSha256 = outputHash.digest("hex");
        if (destination) {
          await destination.sync();
          const temporaryBefore = await destination.stat();
          if (
            !temporaryBefore.isFile() ||
            temporaryBefore.nlink !== 1 ||
            temporaryBefore.size !== before.size + 44 ||
            temporaryBefore.blocks * 512 < temporaryBefore.size
          ) {
            throw new Error("formal media temporary output is invalid");
          }
          const persistedHash = createHash("sha256");
          let persistedOffset = 0;
          while (persistedOffset < temporaryBefore.size) {
            const buffer = Buffer.allocUnsafe(
              Math.min(1024 * 1024, temporaryBefore.size - persistedOffset),
            );
            const { bytesRead } = await destination.read(
              buffer,
              0,
              buffer.length,
              persistedOffset,
            );
            if (bytesRead === 0) break;
            persistedHash.update(buffer.subarray(0, bytesRead));
            persistedOffset += bytesRead;
          }
          const temporaryAfter = await destination.stat();
          if (
            persistedOffset !== temporaryBefore.size ||
            temporaryAfter.dev !== temporaryBefore.dev ||
            temporaryAfter.ino !== temporaryBefore.ino ||
            temporaryAfter.size !== temporaryBefore.size ||
            temporaryAfter.mtimeMs !== temporaryBefore.mtimeMs ||
            temporaryAfter.ctimeMs !== temporaryBefore.ctimeMs ||
            persistedHash.digest("hex") !== normalizedSha256
          ) {
            throw new Error("formal media temporary output changed");
          }
          await destination.close();
        }
        await assertPathIdentity(
          captionRoot,
          captionHandle,
          "capture caption root",
        );
        await assertPathIdentity(
          options.profile.mediaDirectory,
          mediaHandle,
          "profile media root",
        );
        if (destination) {
          await rename(temporaryPath, finalPath);
          temporaryCreated = false;
          await mediaHandle.sync();
        }
        const receipt: FormalCaptureMedia = {
          normalizedPath: finalPath,
          normalizedSha256,
          sourceSha256: options.recordingSha256,
          normalizedSizeBytes: before.size + 44,
          durationMs: before.size / 32,
          receipt: {
            schemaVersion: 1,
            kind: "capture-formal-wav",
            recordingSha256: options.recordingSha256,
            journalSha256: options.journalSha256,
            spoolSha256,
            spoolBytes: before.size,
            outputSha256: normalizedSha256,
            outputBytes: before.size + 44,
            sampleRate: 16_000,
            channels: 1,
            pcm: "s16le",
          },
        };
        await validateFormalMediaAuthority(options.profile, receipt);
        return receipt;
      } finally {
        await destination?.close().catch(() => undefined);
      }
    } finally {
      await source.close();
    }
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    await Promise.all([
      mediaHandle.close(),
      captionHandle.close(),
      sessionHandle.close(),
      captureHandle.close(),
    ]);
  }
}

export async function validateFormalMediaAuthority(
  profile: AudioProfilePaths,
  media: FormalCaptureMedia,
): Promise<void> {
  const root = await realpath(profile.mediaDirectory);
  const candidateParent = await realpath(path.dirname(media.normalizedPath));
  if (candidateParent !== root) {
    throw new Error("formal media escaped the profile media root");
  }
  const rootHandle = await openDirectory(root);
  try {
    await assertPathIdentity(root, rootHandle, "profile media root");
    const handle = await open(
      media.normalizedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await assertPathIdentity(root, rootHandle, "profile media root");
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size !== media.normalizedSizeBytes ||
        before.blocks * 512 < before.size
      ) {
        throw new Error("formal media is not a bounded regular file");
      }
      const hash = createHash("sha256");
      let offset = 0;
      while (offset < before.size) {
        const buffer = Buffer.allocUnsafe(
          Math.min(1024 * 1024, before.size - offset),
        );
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          offset,
        );
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const [after, current] = await Promise.all([
        handle.stat(),
        lstat(media.normalizedPath).catch(() => null),
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
        current.ino !== before.ino ||
        hash.digest("hex") !== media.normalizedSha256
      ) {
        throw new Error("formal media authority changed while validating");
      }
      await assertPathIdentity(root, rootHandle, "profile media root");
    } finally {
      await handle.close();
    }
  } finally {
    await rootHandle.close();
  }
}

function wavHeader(dataBytes: number): Buffer {
  if (
    !Number.isSafeInteger(dataBytes) ||
    dataBytes <= 0 ||
    dataBytes > 0xffff_ffff
  ) {
    throw new Error("caption spool is too large for WAVE");
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(dataBytes + 36, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
