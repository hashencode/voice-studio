import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SecureCompanionTransferStore } from "../../src/main/features/companion/secure_transfer_store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("secure companion transfer staging", () => {
  it("resumes only verified chunks and atomically stages an exact whole-file hash", () => {
    const bytes = Buffer.alloc(5_000, 0x5a);
    const manifest = fixtureManifest(bytes);
    const root = temporaryRoot();
    const store = new SecureCompanionTransferStore(root, {
      availableBytes: () => 2_000_000_000,
    });
    store.begin(manifest);
    store.writeVerifiedChunk(
      manifest,
      fixtureChunk(manifest, 0, bytes.subarray(0, 4_096)),
      bytes.subarray(0, 4_096),
    );
    expect(
      store.missingChunks(manifest, [
        fixtureChunk(manifest, 0, bytes.subarray(0, 4_096)),
      ]),
    ).toEqual([1]);

    const restarted = new SecureCompanionTransferStore(root, {
      availableBytes: () => 2_000_000_000,
    });
    restarted.begin(manifest);
    restarted.writeVerifiedChunk(
      manifest,
      fixtureChunk(manifest, 1, bytes.subarray(4_096)),
      bytes.subarray(4_096),
    );
    const staged = restarted.verifyAndStage(manifest, [
      fixtureChunk(manifest, 0, bytes.subarray(0, 4_096)),
      fixtureChunk(manifest, 1, bytes.subarray(4_096)),
    ]);
    expect(readFileSync(staged)).toEqual(bytes);
    expect(lstatSync(staged).nlink).toBe(1);
  });

  it("fails closed for low disk, symlink roots, and hard-linked chunks", () => {
    const bytes = Buffer.alloc(4_096, 0x33);
    const manifest = fixtureManifest(bytes);
    const lowDiskRoot = temporaryRoot();
    expect(() => {
      const lowDisk = new SecureCompanionTransferStore(lowDiskRoot, {
        availableBytes: () => 1,
      });
      lowDisk.begin(manifest);
    }).toThrowError(
      expect.objectContaining({ code: "INSUFFICIENT_DISK_SPACE" }),
    );

    const parent = temporaryRoot();
    new SecureCompanionTransferStore(parent);
    const target = join(parent, "target");
    const linked = join(parent, "linked");
    new SecureCompanionTransferStore(target, {
      availableBytes: () => 2_000_000_000,
    });
    symlinkSync(target, linked);
    expect(() => new SecureCompanionTransferStore(linked)).toThrowError(
      expect.objectContaining({ code: "UNSAFE_TRANSFER_ROOT" }),
    );

    const store = new SecureCompanionTransferStore(target, {
      availableBytes: () => 2_000_000_000,
    });
    store.begin(manifest);
    const chunk = fixtureChunk(manifest, 0, bytes);
    store.writeVerifiedChunk(manifest, chunk, bytes);
    const chunkPath = store.chunkPathForTesting(manifest, 0);
    linkSync(chunkPath, join(parent, "hard-link"));
    expect(() => store.missingChunks(manifest, [chunk])).toThrowError(
      expect.objectContaining({ code: "UNSAFE_TRANSFER_FILE" }),
    );
  });

  it("never publishes a complete file after whole-file corruption", () => {
    const bytes = Buffer.alloc(4_096, 0x44);
    const manifest = {
      ...fixtureManifest(bytes),
      wholeFileSha256: "a".repeat(64),
    };
    const root = temporaryRoot();
    const store = new SecureCompanionTransferStore(root, {
      availableBytes: () => 2_000_000_000,
    });
    store.begin(manifest);
    store.writeVerifiedChunk(manifest, fixtureChunk(manifest, 0, bytes), bytes);
    expect(() =>
      store.verifyAndStage(manifest, [fixtureChunk(manifest, 0, bytes)]),
    ).toThrowError(
      expect.objectContaining({ code: "WHOLE_FILE_HASH_MISMATCH" }),
    );
    expect(() =>
      readFileSync(store.completedPathForTesting(manifest)),
    ).toThrow();
  });

  it("quarantines same-length chunk corruption so the sender can retransmit it", () => {
    const bytes = Buffer.alloc(4_096, 0x55);
    const manifest = fixtureManifest(bytes);
    const chunk = fixtureChunk(manifest, 0, bytes);
    const root = temporaryRoot();
    const store = new SecureCompanionTransferStore(root, {
      availableBytes: () => 2_000_000_000,
    });
    store.begin(manifest);
    store.writeVerifiedChunk(manifest, chunk, bytes);
    writeFileSync(
      store.chunkPathForTesting(manifest, 0),
      Buffer.alloc(bytes.length, 0x56),
    );
    expect(store.missingChunks(manifest, [chunk])).toEqual([0]);
    expect(() =>
      readFileSync(store.chunkPathForTesting(manifest, 0)),
    ).toThrow();
    store.writeVerifiedChunk(manifest, chunk, bytes);
    expect(store.missingChunks(manifest, [chunk])).toEqual([]);
  });

  it("removes only controlled crash temporaries and idempotently discards staging", () => {
    const bytes = Buffer.alloc(4_096, 0x66);
    const manifest = fixtureManifest(bytes);
    const root = temporaryRoot();
    const store = new SecureCompanionTransferStore(root, {
      availableBytes: () => 2_000_000_000,
    });
    store.begin(manifest);
    const directory = dirname(store.chunkPathForTesting(manifest, 0));
    writeFileSync(join(directory, `.tmp-${"a".repeat(32)}`), bytes);
    writeFileSync(
      join(directory, `complete.media.tmp-${"b".repeat(32)}`),
      bytes,
    );
    const restarted = new SecureCompanionTransferStore(root, {
      availableBytes: () => 2_000_000_000,
    });
    expect(() =>
      readFileSync(join(directory, `.tmp-${"a".repeat(32)}`)),
    ).toThrow();
    expect(() =>
      readFileSync(join(directory, `complete.media.tmp-${"b".repeat(32)}`)),
    ).toThrow();
    restarted.discardStaging(manifest);
    restarted.discardStaging(manifest);
    expect(() => lstatSync(directory)).toThrow();
  });
});

function temporaryRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "voice2text-companion-store-"));
  roots.push(parent);
  const root = join(parent, "private");
  chmodSync(parent, 0o700);
  return root;
}

function fixtureManifest(bytes: Buffer) {
  return {
    schema: "companion-audio-transfer/v2" as const,
    transferId: "transfer-1",
    sourceAssetId: "asset-1",
    displayName: "meeting.wav",
    sizeBytes: bytes.length,
    wholeFileSha256: sha256(bytes),
    chunkBytes: 4_096,
    chunkCount: Math.ceil(bytes.length / 4_096),
    createdAtMs: 1,
  };
}

function fixtureChunk(
  manifest: ReturnType<typeof fixtureManifest>,
  index: number,
  bytes: Buffer,
) {
  return {
    transferId: manifest.transferId,
    index,
    offset: index * manifest.chunkBytes,
    plaintextBytes: bytes.length,
    sha256: sha256(bytes),
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
