import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

export async function validatePinnedMediaAuthority(options: {
  authorityPath: string;
  authorityDirectory: string;
  expectedBytes: number;
  expectedSha256: string;
}): Promise<void> {
  if (
    !Number.isSafeInteger(options.expectedBytes) ||
    options.expectedBytes < 1 ||
    !/^[a-f0-9]{64}$/.test(options.expectedSha256)
  ) {
    throw new Error("media authority identity is invalid");
  }
  if (
    !path.isAbsolute(options.authorityDirectory) ||
    !path.isAbsolute(options.authorityPath)
  ) {
    throw new Error("media authority paths must be absolute");
  }
  const presentedDirectory = path.resolve(options.authorityDirectory);
  const directoryBefore = await lstat(presentedDirectory);
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
    throw new Error("media authority directory is unsafe");
  }
  const directory = await realpath(presentedDirectory);
  const presentedParent = path.dirname(path.resolve(options.authorityPath));
  if (
    presentedParent !== presentedDirectory ||
    (await realpath(presentedParent)) !== directory
  ) {
    throw new Error("media authority escaped its pinned directory");
  }
  const directoryHandle = await openDirectory(presentedDirectory);
  try {
    await assertDirectoryIdentity(presentedDirectory, directoryHandle);
    const handle = await open(
      options.authorityPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch(() => {
      throw new Error("media authority is unavailable");
    });
    try {
      await assertDirectoryIdentity(presentedDirectory, directoryHandle);
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size !== options.expectedBytes ||
        before.blocks * 512 < before.size ||
        (typeof process.getuid === "function" &&
          before.uid !== process.getuid())
      ) {
        throw new Error("media authority is not a private regular file");
      }
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < before.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - offset),
          offset,
        );
        if (bytesRead === 0) break;
        digest.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const [after, current] = await Promise.all([
        handle.stat(),
        lstat(options.authorityPath).catch(() => null),
      ]);
      await assertDirectoryIdentity(presentedDirectory, directoryHandle);
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
        digest.digest("hex") !== options.expectedSha256
      ) {
        throw new Error("media authority changed while validating");
      }
    } finally {
      await handle.close();
    }
  } finally {
    await directoryHandle.close();
  }
}

async function openDirectory(directory: string): Promise<FileHandle> {
  return await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
}

async function assertDirectoryIdentity(
  directory: string,
  handle: FileHandle,
): Promise<void> {
  const [pinned, current] = await Promise.all([
    handle.stat(),
    lstat(directory),
  ]);
  if (
    !pinned.isDirectory() ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    pinned.dev !== current.dev ||
    pinned.ino !== current.ino
  ) {
    throw new Error("media authority directory was replaced");
  }
}
