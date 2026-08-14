import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  companionTransferManifestSchema,
  type CompanionTransferManifest,
} from "../../../shared/contracts";

const defaultMinimumFreeBytes = 512 * 1024 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/;

export class SecureTransferStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SecureTransferStoreError";
  }
}

export interface CompanionWireChunk {
  transferId: string;
  index: number;
  offset: number;
  plaintextBytes: number;
  sha256: string;
}

export interface CompanionTransferIdentity {
  transferId: string;
  wholeFileSha256: string;
}

export class SecureCompanionTransferStore {
  private readonly root: string;
  private readonly rootIdentity: FileIdentity;
  private readonly availableBytes: () => number;
  private readonly minimumFreeBytes: number;

  constructor(
    rootPath: string,
    options: {
      availableBytes?: () => number;
      minimumFreeBytes?: number;
    } = {},
  ) {
    if (!isAbsolute(rootPath)) {
      throw new SecureTransferStoreError(
        "UNSAFE_TRANSFER_ROOT",
        "transfer root must be absolute",
      );
    }
    ensureDirectory(rootPath, 0o700);
    const rootStat = lstatSync(rootPath);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      rootStat.uid !== process.getuid?.()
    ) {
      throw new SecureTransferStoreError(
        "UNSAFE_TRANSFER_ROOT",
        "transfer root is not private",
      );
    }
    if ((rootStat.mode & 0o077) !== 0) chmodSync(rootPath, 0o700);
    const canonical = realpathSync(rootPath);
    this.root = canonical;
    this.rootIdentity = identity(lstatSync(canonical));
    this.availableBytes =
      options.availableBytes ?? (() => freeBytes(canonical));
    this.minimumFreeBytes = options.minimumFreeBytes ?? defaultMinimumFreeBytes;
    this.cleanupOrphanedTemps();
  }

  begin(rawManifest: CompanionTransferManifest): void {
    const manifest = companionTransferManifestSchema.parse(rawManifest);
    this.assertRootStable();
    const available = this.availableBytes();
    if (
      !Number.isSafeInteger(available) ||
      available < manifest.sizeBytes + this.minimumFreeBytes
    ) {
      throw new SecureTransferStoreError(
        "INSUFFICIENT_DISK_SPACE",
        "desktop does not have enough free space for transfer",
      );
    }
    const bindingPath = this.bindingPath(manifest.transferId);
    const binding = `${manifest.transferId}:${manifest.wholeFileSha256}`;
    writeExclusiveAtomic(bindingPath, Buffer.from(binding, "utf8"), this.root);
    const storedBinding = readPinned(
      bindingPath,
      Buffer.byteLength(binding, "utf8"),
    ).toString("utf8");
    if (storedBinding !== binding) {
      throw new SecureTransferStoreError(
        "TRANSFER_ID_CONFLICT",
        "transfer id is already bound to different content",
      );
    }

    const directory = this.directory(manifest);
    ensureDirectory(directory, 0o700);
    const directoryIdentity = this.assertDirectory(directory);
    this.cleanupControlledTemps(directory);
    const encoded = Buffer.from(JSON.stringify(manifest), "utf8");
    const manifestPath = join(directory, "manifest.json");
    writeExclusiveAtomic(manifestPath, encoded, directory);
    const existing = companionTransferManifestSchema.parse(
      JSON.parse(readPinned(manifestPath, encoded.length).toString("utf8")),
    );
    if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
      throw new SecureTransferStoreError(
        "TRANSFER_ID_CONFLICT",
        "manifest identity changed",
      );
    }
    this.assertDirectory(directory, directoryIdentity);
    this.assertRootStable();
  }

  writeVerifiedChunk(
    manifest: CompanionTransferManifest,
    chunk: CompanionWireChunk,
    bytes: Buffer,
  ): void {
    validateChunk(manifest, chunk, bytes);
    const directory = this.directory(manifest);
    const directoryIdentity = this.assertDirectory(directory);
    const path = this.chunkPathForTesting(manifest, chunk.index);
    writeExclusiveAtomic(path, bytes, directory);
    const promoted = readPinned(path, bytes.length);
    if (sha256(promoted) !== chunk.sha256) {
      throw new SecureTransferStoreError(
        "CHUNK_CONFLICT",
        "promoted chunk hash changed",
      );
    }
    this.assertDirectory(directory, directoryIdentity);
  }

  missingChunks(
    manifest: CompanionTransferManifest,
    verifiedChunks: readonly CompanionWireChunk[],
  ): number[] {
    const directory = this.directory(manifest);
    const directoryIdentity = this.assertDirectory(directory);
    const verified = exactChunks(verifiedChunks, manifest, false);
    const valid = new Set<number>();
    for (const chunk of verified) {
      const path = this.chunkPathForTesting(manifest, chunk.index);
      try {
        const bytes = readPinned(path, chunk.plaintextBytes);
        if (sha256(bytes) === chunk.sha256) {
          valid.add(chunk.index);
          continue;
        }
        unlinkPrivateCorruptFile(path, directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.assertDirectory(directory, directoryIdentity);
    return Array.from(
      { length: manifest.chunkCount },
      (_, index) => index,
    ).filter((index) => !valid.has(index));
  }

  verifyAndStage(
    manifest: CompanionTransferManifest,
    verifiedChunks: readonly CompanionWireChunk[],
  ): string {
    const directory = this.directory(manifest);
    const directoryIdentity = this.assertDirectory(directory);
    this.cleanupControlledTemps(directory);
    const chunks = exactChunks(verifiedChunks, manifest, true);
    const completed = this.completedPathForTesting(manifest);
    try {
      const digest = hashPinnedFile(completed, manifest.sizeBytes);
      if (digest !== manifest.wholeFileSha256) {
        throw new SecureTransferStoreError(
          "STAGED_FILE_CONFLICT",
          "completed file conflicts",
        );
      }
      return completed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const temporary = join(
      directory,
      `complete.media.tmp-${randomBytes(16).toString("hex")}`,
    );
    const descriptor = openPrivateExclusive(temporary);
    const digest = createHash("sha256");
    let total = 0;
    try {
      for (const chunk of chunks) {
        const bytes = readPinned(
          this.chunkPathForTesting(manifest, chunk.index),
          chunk.plaintextBytes,
        );
        if (sha256(bytes) !== chunk.sha256) {
          throw new SecureTransferStoreError(
            "CHUNK_HASH_MISMATCH",
            "verified chunk changed",
          );
        }
        digest.update(bytes);
        writeAll(descriptor, bytes);
        total += bytes.length;
      }
      fsyncSync(descriptor);
    } catch (error) {
      closeSync(descriptor);
      safeUnlink(temporary);
      throw error;
    }
    closeSync(descriptor);
    if (
      total !== manifest.sizeBytes ||
      digest.digest("hex") !== manifest.wholeFileSha256
    ) {
      safeUnlink(temporary);
      throw new SecureTransferStoreError(
        "WHOLE_FILE_HASH_MISMATCH",
        "reassembled transfer does not match manifest",
      );
    }
    if (
      hashPinnedFile(temporary, manifest.sizeBytes) !== manifest.wholeFileSha256
    ) {
      safeUnlink(temporary);
      throw new SecureTransferStoreError(
        "WHOLE_FILE_HASH_MISMATCH",
        "temporary transfer changed",
      );
    }
    const promotedIdentity = identity(lstatSync(temporary));
    try {
      promoteWithoutOverwrite(temporary, completed, directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (
        hashPinnedFile(completed, manifest.sizeBytes) ===
        manifest.wholeFileSha256
      )
        return completed;
      throw new SecureTransferStoreError(
        "STAGED_FILE_CONFLICT",
        "completed destination appeared",
      );
    }
    try {
      if (
        hashPinnedFile(completed, manifest.sizeBytes) !==
        manifest.wholeFileSha256
      ) {
        throw new SecureTransferStoreError(
          "WHOLE_FILE_HASH_MISMATCH",
          "promoted transfer changed before import",
        );
      }
      this.assertDirectory(directory, directoryIdentity);
    } catch (error) {
      removeIfSamePrivateFile(completed, promotedIdentity);
      throw error;
    }
    return completed;
  }

  finalizeCommitted(manifest: CompanionTransferManifest): void {
    this.discardStaging(manifest);
  }

  cancel(manifest: CompanionTransferManifest): void {
    this.discardStaging(manifest);
  }

  discardStaging(identityValue: CompanionTransferIdentity): void {
    const directory = this.directory(identityValue);
    if (entityType(directory) === "directory") {
      const directoryIdentity = this.assertDirectory(directory);
      for (const name of readdirSync(directory)) {
        if (!isControlledTransferEntry(name)) {
          throw new SecureTransferStoreError(
            "UNSAFE_TRANSFER_FILE",
            "unexpected staging entry",
          );
        }
        unlinkPrivateOwnedFile(join(directory, name), directory);
      }
      this.assertDirectory(directory, directoryIdentity);
      rmdirSync(directory);
    } else if (entityType(directory) !== "missing") {
      throw new SecureTransferStoreError(
        "UNSAFE_TRANSFER_ROOT",
        "transfer staging directory is unsafe",
      );
    }
    const bindingPath = this.bindingPath(identityValue.transferId);
    const bindingType = entityType(bindingPath);
    if (bindingType === "file") {
      const expected = Buffer.from(
        `${identityValue.transferId}:${identityValue.wholeFileSha256}`,
        "utf8",
      );
      if (!readPinned(bindingPath, expected.length).equals(expected)) {
        throw new SecureTransferStoreError(
          "TRANSFER_ID_CONFLICT",
          "cleanup binding identity changed",
        );
      }
      unlinkPrivateOwnedFile(bindingPath, this.root);
    } else if (bindingType !== "missing") {
      throw new SecureTransferStoreError(
        "UNSAFE_TRANSFER_FILE",
        "cleanup binding is unsafe",
      );
    }
    fsyncDirectory(this.root);
  }

  cleanupOrphanedTemps(): void {
    this.assertRootStable();
    for (const name of readdirSync(this.root)) {
      const path = join(this.root, name);
      if (/^\.tmp-[a-f0-9]{32}$/.test(name)) {
        unlinkPrivateOwnedFile(path, this.root);
        continue;
      }
      if (/^[a-f0-9]{64}$/.test(name) && entityType(path) === "directory") {
        this.cleanupControlledTemps(path);
      }
    }
    fsyncDirectory(this.root);
  }

  chunkPathForTesting(
    manifest: CompanionTransferManifest,
    index: number,
  ): string {
    return join(this.directory(manifest), `chunk-${index}.part`);
  }

  completedPathForTesting(manifest: CompanionTransferManifest): string {
    return join(this.directory(manifest), "complete.media");
  }

  private directory(manifest: CompanionTransferIdentity): string {
    const key = sha256(
      Buffer.from(`${manifest.transferId}:${manifest.wholeFileSha256}`, "utf8"),
    );
    return safeChild(this.root, key);
  }

  private bindingPath(transferId: string): string {
    return safeChild(
      this.root,
      `transfer-${sha256(Buffer.from(transferId, "utf8"))}.binding`,
    );
  }

  private assertRootStable(): void {
    const stat = lstatSync(this.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !sameIdentity(this.rootIdentity, identity(stat)) ||
      realpathSync(this.root) !== this.root
    ) {
      throw new SecureTransferStoreError(
        "UNSAFE_TRANSFER_ROOT",
        "transfer root identity changed",
      );
    }
  }

  private assertDirectory(
    directory: string,
    expected?: FileIdentity,
  ): FileIdentity {
    this.assertRootStable();
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(directory) !== directory
    ) {
      throw new SecureTransferStoreError(
        "UNSAFE_TRANSFER_ROOT",
        "transfer directory is unsafe",
      );
    }
    const current = identity(stat);
    if (expected && !sameIdentity(expected, current)) {
      throw new SecureTransferStoreError(
        "UNSAFE_TRANSFER_ROOT",
        "transfer directory identity changed",
      );
    }
    return current;
  }

  private cleanupControlledTemps(directory: string): void {
    const directoryIdentity = this.assertDirectory(directory);
    for (const name of readdirSync(directory)) {
      if (
        /^\.tmp-[a-f0-9]{32}$/.test(name) ||
        /^complete\.media\.tmp-[a-f0-9]{32}$/.test(name)
      ) {
        unlinkPrivateOwnedFile(join(directory, name), directory);
      }
    }
    this.assertDirectory(directory, directoryIdentity);
    fsyncDirectory(directory);
  }
}

interface FileIdentity {
  dev: number;
  ino: number;
}

function identity(stat: Stats): FileIdentity {
  return { dev: Number(stat.dev), ino: Number(stat.ino) };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ensureDirectory(path: string, mode: number): void {
  try {
    mkdirSync(path, { recursive: false, mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function safeChild(root: string, name: string): string {
  const candidate = resolve(root, name);
  const child = relative(root, candidate);
  if (
    !child ||
    child.startsWith("..") ||
    isAbsolute(child) ||
    dirname(candidate) !== root
  ) {
    throw new SecureTransferStoreError(
      "PATH_ESCAPE_REJECTED",
      "staging path escaped root",
    );
  }
  return candidate;
}

function isControlledTransferEntry(name: string): boolean {
  return (
    name === "manifest.json" ||
    name === "complete.media" ||
    /^chunk-\d+\.part$/.test(name) ||
    /^\.tmp-[a-f0-9]{32}$/.test(name) ||
    /^complete\.media\.tmp-[a-f0-9]{32}$/.test(name)
  );
}

function unlinkPrivateOwnedFile(path: string, expectedParent: string): void {
  if (dirname(path) !== expectedParent) {
    throw new SecureTransferStoreError(
      "PATH_ESCAPE_REJECTED",
      "cleanup path escaped root",
    );
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.()
  ) {
    throw new SecureTransferStoreError(
      "UNSAFE_TRANSFER_FILE",
      "cleanup target is not a private owned file",
    );
  }
  unlinkSync(path);
}

function entityType(path: string): "missing" | "file" | "directory" | "other" {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return "other";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function writeExclusiveAtomic(
  path: string,
  bytes: Buffer,
  directory: string,
): void {
  try {
    readPinned(path, bytes.length);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(directory, `.tmp-${randomBytes(16).toString("hex")}`);
  const descriptor = openPrivateExclusive(temporary);
  try {
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    safeUnlink(temporary);
    throw error;
  }
  closeSync(descriptor);
  try {
    promoteWithoutOverwrite(temporary, path, directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    safeUnlink(temporary);
  }
  const existing = readPinned(path, bytes.length);
  if (!existing.equals(bytes)) {
    throw new SecureTransferStoreError(
      "CHUNK_CONFLICT",
      "existing staged bytes conflict",
    );
  }
}

function promoteWithoutOverwrite(
  temporary: string,
  destination: string,
  directory: string,
): void {
  try {
    linkSync(temporary, destination);
    unlinkSync(temporary);
    fsyncDirectory(directory);
  } catch (error) {
    safeUnlink(temporary);
    throw error;
  }
}

function openPrivateExclusive(path: string): number {
  return openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (written <= 0)
      throw new SecureTransferStoreError(
        "SHORT_WRITE",
        "staging write stopped",
      );
    offset += written;
  }
}

function readPinned(path: string, expectedBytes: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    requirePinned(before, expectedBytes);
    const output = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < output.length) {
      const count = readSync(
        descriptor,
        output,
        offset,
        output.length - offset,
        offset,
      );
      if (count === 0)
        throw new SecureTransferStoreError(
          "UNSAFE_TRANSFER_FILE",
          "file truncated",
        );
      offset += count;
    }
    const after = fstatSync(descriptor);
    requirePinned(after, expectedBytes);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new SecureTransferStoreError(
        "UNSAFE_TRANSFER_FILE",
        "file changed during read",
      );
    }
    return output;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SecureTransferStoreError(
        "UNSAFE_TRANSFER_FILE",
        "symbolic link rejected",
      );
    }
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

function hashPinnedFile(path: string, expectedBytes: number): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    requirePinned(before, expectedBytes);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < expectedBytes) {
      const count = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, expectedBytes - offset),
        offset,
      );
      if (count === 0)
        throw new SecureTransferStoreError(
          "UNSAFE_TRANSFER_FILE",
          "file truncated",
        );
      digest.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor);
    requirePinned(after, expectedBytes);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new SecureTransferStoreError(
        "UNSAFE_TRANSFER_FILE",
        "file changed during hash",
      );
    }
    return digest.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function requirePinned(
  stat: ReturnType<typeof fstatSync>,
  expectedBytes: number,
): void {
  if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expectedBytes) {
    throw new SecureTransferStoreError(
      "UNSAFE_TRANSFER_FILE",
      "file is not a private bounded regular file",
    );
  }
}

function validateChunk(
  manifest: CompanionTransferManifest,
  chunk: CompanionWireChunk,
  bytes: Buffer,
): void {
  const expected = expectedChunkLength(manifest, chunk.index);
  if (
    chunk.transferId !== manifest.transferId ||
    chunk.index < 0 ||
    chunk.index >= manifest.chunkCount ||
    chunk.offset !== chunk.index * manifest.chunkBytes ||
    chunk.plaintextBytes !== expected ||
    bytes.length !== expected ||
    !sha256Pattern.test(chunk.sha256) ||
    sha256(bytes) !== chunk.sha256
  ) {
    throw new SecureTransferStoreError(
      "CHUNK_HASH_OR_BOUNDS_MISMATCH",
      "chunk does not match transfer manifest",
    );
  }
}

function expectedChunkLength(
  manifest: CompanionTransferManifest,
  index: number,
): number {
  if (!Number.isInteger(index) || index < 0 || index >= manifest.chunkCount) {
    throw new SecureTransferStoreError(
      "INVALID_CHUNK_INDEX",
      "chunk index is invalid",
    );
  }
  return index < manifest.chunkCount - 1
    ? manifest.chunkBytes
    : manifest.sizeBytes - manifest.chunkBytes * (manifest.chunkCount - 1);
}

function exactChunks(
  chunks: readonly CompanionWireChunk[],
  manifest: CompanionTransferManifest,
  requireComplete: boolean,
): CompanionWireChunk[] {
  const unique = new Set(chunks.map((chunk) => chunk.index));
  if (
    unique.size !== chunks.length ||
    chunks.some(
      (chunk) =>
        chunk.transferId !== manifest.transferId ||
        !Number.isInteger(chunk.index) ||
        chunk.index < 0 ||
        chunk.index >= manifest.chunkCount ||
        chunk.offset !== chunk.index * manifest.chunkBytes ||
        chunk.plaintextBytes !== expectedChunkLength(manifest, chunk.index) ||
        !sha256Pattern.test(chunk.sha256),
    ) ||
    (requireComplete &&
      (chunks.length !== manifest.chunkCount ||
        chunks.some((chunk, offset) => chunk.index !== offset)))
  ) {
    throw new SecureTransferStoreError(
      "INVALID_CHECKPOINT",
      "verified chunk index set is invalid",
    );
  }
  return [...chunks];
}

function unlinkPrivateCorruptFile(path: string, directory: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    dirname(path) !== directory
  ) {
    throw new SecureTransferStoreError(
      "UNSAFE_TRANSFER_FILE",
      "corrupt chunk cannot be quarantined safely",
    );
  }
  unlinkSync(path);
  fsyncDirectory(directory);
}

function removeIfSamePrivateFile(path: string, expected: FileIdentity): void {
  try {
    const stat = lstatSync(path);
    if (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      sameIdentity(identity(stat), expected)
    ) {
      unlinkSync(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function freeBytes(path: string): number {
  const stat = statfsSync(path);
  return Number(stat.bavail) * Number(stat.bsize);
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
