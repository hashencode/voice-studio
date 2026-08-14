import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { sha256FileWithShasum } from "./shasum_file";
import { assertMacOSArm64ResourceHost } from "./resource_target";

assertMacOSArm64ResourceHost();

const root = path.resolve(process.argv[2] ?? "resources/worker");
const rootMetadata = await lstat(root);
if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
  throw new Error("worker resource root must be a private directory");
}
const canonicalRoot = await realpath(root);
const manifestPath = path.join(canonicalRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  schemaVersion?: unknown;
  target?: unknown;
  artifacts?: unknown;
};
if (
  manifest.schemaVersion !== 1 ||
  manifest.target !== "darwin-arm64" ||
  !Array.isArray(manifest.artifacts)
) {
  throw new Error("worker resource manifest target is invalid");
}

const expected = new Map<string, string>();
for (const raw of manifest.artifacts) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("worker resource artifact is invalid");
  }
  const artifact = raw as { path?: unknown; sha256?: unknown };
  if (
    typeof artifact.path !== "string" ||
    !safeRelativePath(artifact.path) ||
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    expected.has(artifact.path)
  ) {
    throw new Error("worker resource artifact is invalid");
  }
  expected.set(artifact.path, artifact.sha256);
}

const actual = await listFiles(canonicalRoot);
if (actual.length !== expected.size + 1) {
  throw new Error("worker resource inventory does not match manifest");
}
for (const file of actual) {
  const relative = path.relative(canonicalRoot, file);
  if (relative === "manifest.json") continue;
  const expectedSha256 = expected.get(relative);
  if (!expectedSha256) {
    throw new Error(`worker resource is not manifested: ${relative}`);
  }
  if ((await sha256FileWithShasum(file)) !== expectedSha256) {
    throw new Error(`worker resource SHA-256 mismatch: ${relative}`);
  }
  expected.delete(relative);
}
if (expected.size !== 0) {
  throw new Error("worker resource manifest names missing artifacts");
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      throw new Error("worker resource inventory contains a symbolic link");
    }
    if (metadata.isDirectory()) {
      files.push(...(await listFiles(candidate)));
      continue;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error("worker resource inventory contains an unsafe entry");
    }
    const canonical = await realpath(candidate);
    const relative = path.relative(canonicalRoot, canonical);
    if (!safeRelativePath(relative)) {
      throw new Error("worker resource inventory escapes its root");
    }
    files.push(canonical);
  }
  return files.sort();
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment !== "" && segment !== "..")
  );
}
