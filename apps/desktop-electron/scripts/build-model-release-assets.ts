import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { pack } from "tar-stream";

import type { LocalModelBundleId } from "../src/shared/contracts";
import { sha256File } from "../src/main/security/sha256_file";

interface ModelReleaseMember {
  source: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface ModelReleaseBuildSpec {
  schemaVersion: 1;
  bundleId: LocalModelBundleId;
  version: string;
  target: "darwin-arm64";
  runtimeProtocol: string;
  sourceRoot: string;
  members: readonly ModelReleaseMember[];
}

export interface ModelReleaseBuildReceipt {
  schemaVersion: 1;
  builder: "voice2text-normalized-model-archive/v1";
  bundleId: LocalModelBundleId;
  version: string;
  target: "darwin-arm64";
  runtimeProtocol: string;
  archivePath: string;
  archiveBytes: number;
  archiveSha256: string;
  inventory: readonly {
    path: string;
    bytes: number;
    sha256: string;
  }[];
}

export async function buildNormalizedModelArchive(
  rawSpec: ModelReleaseBuildSpec,
  outputRoot: string,
): Promise<ModelReleaseBuildReceipt> {
  const spec = validateSpec(rawSpec);
  const canonicalSourceRoot = await realpath(path.resolve(spec.sourceRoot));
  const inventory = [...spec.members]
    .sort((left, right) => left.path.localeCompare(right.path, "en"))
    .map(({ path: memberPath, bytes, sha256 }) => ({
      path: memberPath,
      bytes,
      sha256,
    }));
  for (const member of spec.members) {
    const source = contained(canonicalSourceRoot, member.source);
    const metadata = await lstat(source);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size !== member.bytes ||
      (await sha256File(source)) !== member.sha256
    ) {
      throw new Error(`release input identity mismatch: ${member.source}`);
    }
  }

  const resolvedOutputRoot = path.resolve(outputRoot);
  await mkdir(resolvedOutputRoot, { recursive: true, mode: 0o700 });
  const archiveName = `${spec.bundleId}-${safeFileToken(spec.version)}-${spec.target}.tar.gz`;
  const archivePath = path.join(resolvedOutputRoot, archiveName);
  const archive = pack();
  const compression = createGzip({ level: 9 });
  const writing = pipeline(
    archive,
    compression,
    createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
  );
  try {
    for (const directory of archiveDirectories(inventory)) {
      await writeEntry(archive, {
        name: directory,
        type: "directory",
        mode: 0o755,
        mtime: new Date(0),
        uid: 0,
        gid: 0,
        uname: "",
        gname: "",
      });
    }
    for (const member of inventory) {
      const sourceMember = spec.members.find(
        (candidate) => candidate.path === member.path,
      )!;
      await writeEntry(
        archive,
        {
          name: member.path,
          type: "file",
          size: member.bytes,
          mode: 0o644,
          mtime: new Date(0),
          uid: 0,
          gid: 0,
          uname: "",
          gname: "",
        },
        contained(canonicalSourceRoot, sourceMember.source),
      );
    }
    archive.finalize();
    await writing;
  } catch (error) {
    archive.destroy(error instanceof Error ? error : new Error(String(error)));
    await writing.catch(() => undefined);
    throw error;
  }

  const receipt: ModelReleaseBuildReceipt = {
    schemaVersion: 1,
    builder: "voice2text-normalized-model-archive/v1",
    bundleId: spec.bundleId,
    version: spec.version,
    target: spec.target,
    runtimeProtocol: spec.runtimeProtocol,
    archivePath,
    archiveBytes: (await stat(archivePath)).size,
    archiveSha256: await sha256File(archivePath),
    inventory,
  };
  await writeFile(
    path.join(resolvedOutputRoot, `${archiveName}.receipt.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return receipt;
}

async function writeEntry(
  archive: ReturnType<typeof pack>,
  header: Parameters<typeof archive.entry>[0],
  source?: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const entry = archive.entry(header, (error) => {
      if (error) reject(error);
      else resolve();
    });
    entry.once("error", reject);
    if (source) createReadStream(source).once("error", reject).pipe(entry);
    else entry.end(Buffer.alloc(0));
  });
}

function archiveDirectories(inventory: readonly { path: string }[]): string[] {
  const directories = new Set<string>();
  for (const member of inventory) {
    let current = path.posix.dirname(member.path);
    while (current !== ".") {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return [...directories].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

function validateSpec(spec: ModelReleaseBuildSpec): ModelReleaseBuildSpec {
  if (
    spec.schemaVersion !== 1 ||
    !["formal-transcription", "live-caption"].includes(spec.bundleId) ||
    !spec.version.trim() ||
    spec.target !== "darwin-arm64" ||
    !spec.runtimeProtocol.trim() ||
    !spec.sourceRoot ||
    spec.members.length === 0
  ) {
    throw new Error("model release build spec is invalid");
  }
  const sources = new Set<string>();
  const destinations = new Set<string>();
  for (const member of spec.members) {
    if (
      !safeRelativePath(member.source) ||
      !safeRelativePath(member.path) ||
      sources.has(member.source) ||
      destinations.has(member.path) ||
      !Number.isSafeInteger(member.bytes) ||
      member.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(member.sha256)
    ) {
      throw new Error("model release member is invalid");
    }
    sources.add(member.source);
    destinations.add(member.path);
  }
  return spec;
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function contained(root: string, relative: string): string {
  const candidate = path.resolve(root, relative);
  const relation = path.relative(root, candidate);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error("release input escaped its source root");
  }
  return candidate;
}

function safeFileToken(value: string): string {
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(value)) {
    throw new Error("model release version is not a safe file token");
  }
  return value;
}

if (import.meta.main) {
  const specPath = path.resolve(process.argv[2] ?? "");
  const outputRoot = path.resolve(process.argv[3] ?? "");
  if (!process.argv[2] || !process.argv[3]) {
    throw new Error(
      "usage: bun scripts/build-model-release-assets.ts <spec.json> <output-root>",
    );
  }
  const spec = JSON.parse(
    await readFile(specPath, "utf8"),
  ) as ModelReleaseBuildSpec;
  const receipt = await buildNormalizedModelArchive(spec, outputRoot);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
