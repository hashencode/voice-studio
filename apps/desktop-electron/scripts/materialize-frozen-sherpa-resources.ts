import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sha256FileWithShasum } from "./shasum_file";
import { assertMacOSArm64ResourceHost } from "./resource_target";

assertMacOSArm64ResourceHost();

interface FrozenDownload {
  id: string;
  source: string;
  sha256: string;
  bytes: number;
  kind: "file" | "tar.bz2";
}

interface FrozenFile {
  relativePath: string;
  downloadId: string;
  archiveMember?: string;
  sha256: string;
  bytes: number;
  licenseSpdx: string;
}

interface FrozenAuthority {
  schemaVersion: number;
  setId: string;
  platform: string;
  architecture: string;
  contentKey: string;
  licenseDisposition: string;
  distributionEligible: boolean;
  downloads: FrozenDownload[];
  files: FrozenFile[];
}

interface FrozenSenseVoiceAuthority {
  schemaVersion: number;
  setId: string;
  platform: string;
  architecture: string;
  developmentPosture: string;
  status: string;
  distributionEligible: boolean;
  developmentEligible: boolean;
  licenseDisposition: string;
  model: {
    source: string;
    archiveSha256: string;
    modelRelativePath: string;
    modelSha256: string;
    tokensRelativePath: string;
    tokensSha256: string;
  };
  vad: { source: string; sha256: string };
  control: {
    runtime: string;
    provider: string;
    threads: number;
    concurrency: number;
    decodingMethod: string;
    language: string;
    useInverseTextNormalization: boolean;
    maximumUtteranceSeconds: number;
    publishesTokenPartials: boolean;
  };
}

interface FrozenSenseVoiceLock {
  schemaVersion: number;
  target: string;
  frozenReferenceSha256: string;
  archiveBytes: number;
  vadBytes: number;
  archiveMembers: { model: string; tokens: string };
}

const runtimeArchive = {
  id: "sherpa-onnx-macos-runtime",
  package: "sherpa_onnx_macos",
  version: "1.13.4",
  source: "https://pub.dev/api/archives/sherpa_onnx_macos-1.13.4.tar.gz",
  sha256: "55164fa38db3de870dc834b855be6b6b5cc0acb7663d74cea76c3de4e7bd7a47",
};
const runtimeMembers = [
  "libonnxruntime.1.27.0.dylib",
  "libsherpa-onnx-c-api.dylib",
  "libsherpa-onnx-cxx-api.dylib",
] as const;

const authorityPath = path.resolve(
  process.argv[2] ??
    "../desktop/assets/processing/frozen_sherpa_macos_arm64.json",
);
const outputRoot = path.resolve(process.argv[3] ?? "resources/worker");
const rootLockPath = path.resolve(process.argv[4] ?? "../../pubspec.lock");
const temporaryRoot = process.argv[5]
  ? await validatedSuppliedTemporaryRoot(process.argv[5])
  : await mkdtemp(path.join(os.tmpdir(), "voice2text-electron-sherpa-"));
const senseVoiceAuthorityPath = path.resolve(
  process.argv[6] ??
    "../desktop/assets/processing/frozen_sensevoice_macos_arm64.json",
);
const senseVoiceLockPath = path.resolve(
  process.argv[7] ??
    "assets/processing/frozen_sensevoice_macos_arm64.lock.json",
);
const liveCaptionOnly = process.env.VOICE2TEXT_LIVE_CAPTION_ONLY === "1";

try {
  const authorityBytes = await readFile(authorityPath);
  const senseVoiceAuthorityBytes = await readFile(senseVoiceAuthorityPath);
  const senseVoiceLock = validateSenseVoiceLock(
    JSON.parse(await readFile(senseVoiceLockPath, "utf8")) as unknown,
  );
  if (
    createHash("sha256").update(senseVoiceAuthorityBytes).digest("hex") !==
    senseVoiceLock.frozenReferenceSha256
  ) {
    throw new Error("frozen SenseVoice reference hash disagrees with lock");
  }
  assertRuntimeLock(await readFile(rootLockPath, "utf8"));
  const authority = validateAuthority(
    JSON.parse(authorityBytes.toString("utf8")) as unknown,
  );
  const senseVoiceAuthority = validateSenseVoiceAuthority(
    JSON.parse(senseVoiceAuthorityBytes.toString("utf8")) as unknown,
  );
  await mkdir(path.join(outputRoot, "models"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(path.join(outputRoot, "runtime"), {
    recursive: true,
    mode: 0o700,
  });

  const sourceReceipts: Array<Record<string, unknown>> = [];
  const memberReceipts: Array<Record<string, unknown>> = [];
  if (!liveCaptionOnly) {
    for (const download of authority.downloads) {
      const downloadPath = path.join(temporaryRoot, `${download.id}.download`);
      await freshDownload(download.source, downloadPath);
      await assertFileIdentity(downloadPath, download.bytes, download.sha256);
      sourceReceipts.push({
        id: download.id,
        source: download.source,
        bytes: download.bytes,
        sha256: download.sha256,
      });
      const members = authority.files.filter(
        (candidate) => candidate.downloadId === download.id,
      );
      const extractionRoot = path.join(temporaryRoot, `${download.id}.members`);
      if (download.kind === "tar.bz2") {
        await extractMembers(
          downloadPath,
          extractionRoot,
          members.map((member) => member.archiveMember ?? ""),
          "j",
        );
      }
      for (const member of members) {
        const destination = containedOutput(
          outputRoot,
          path.join("models", member.relativePath),
        );
        await mkdir(path.dirname(destination), {
          recursive: true,
          mode: 0o700,
        });
        if (download.kind === "file") {
          if (member.archiveMember !== undefined) {
            throw new Error(
              "direct frozen download unexpectedly names a member",
            );
          }
          await copyFile(downloadPath, destination);
        } else {
          if (!member.archiveMember) {
            throw new Error("frozen archive member is missing");
          }
          const extracted = containedOutput(
            extractionRoot,
            member.archiveMember,
          );
          await assertPrivateRegularFile(extracted, extractionRoot);
          await copyFile(extracted, destination);
        }
        await assertFileIdentity(destination, member.bytes, member.sha256);
        memberReceipts.push({
          path: path.relative(outputRoot, destination),
          downloadId: member.downloadId,
          archiveMember: member.archiveMember,
          bytes: member.bytes,
          sha256: member.sha256,
        });
      }
      await rm(downloadPath, { force: true });
    }

    const runtimeDownloadPath = path.join(temporaryRoot, "runtime.tar.gz");
    await freshDownload(runtimeArchive.source, runtimeDownloadPath);
    const runtimeArchiveIdentity =
      await sha256FileWithShasum(runtimeDownloadPath);
    if (runtimeArchiveIdentity !== runtimeArchive.sha256) {
      throw new Error("fresh Sherpa runtime archive hash mismatch");
    }
    sourceReceipts.push({
      id: runtimeArchive.id,
      source: runtimeArchive.source,
      bytes: (await stat(runtimeDownloadPath)).size,
      sha256: runtimeArchive.sha256,
    });
    const runtimeExtractionRoot = path.join(temporaryRoot, "runtime-members");
    await extractMembers(
      runtimeDownloadPath,
      runtimeExtractionRoot,
      runtimeMembers.map((name) => `macos/${name}`),
      "z",
    );
    for (const runtimeName of runtimeMembers) {
      const destination = containedOutput(
        outputRoot,
        path.join("runtime", runtimeName),
      );
      const extracted = containedOutput(
        runtimeExtractionRoot,
        `macos/${runtimeName}`,
      );
      await assertPrivateRegularFile(extracted, runtimeExtractionRoot);
      await copyFile(extracted, destination);
      memberReceipts.push({
        path: path.relative(outputRoot, destination),
        downloadId: runtimeArchive.id,
        archiveMember: `macos/${runtimeName}`,
        bytes: (await stat(destination)).size,
        sha256: await sha256FileWithShasum(destination),
      });
    }
  }

  await materializeSenseVoice({
    authority: senseVoiceAuthority,
    lock: senseVoiceLock,
    outputRoot,
    temporaryRoot,
    sourceReceipts,
    memberReceipts,
  });

  if (!liveCaptionOnly) {
    await writeFile(
      path.join(outputRoot, "frozen-authority.json"),
      authorityBytes,
      { mode: 0o600 },
    );
  }
  await writeFile(
    path.join(outputRoot, "frozen-sensevoice-authority.json"),
    senseVoiceAuthorityBytes,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(
      outputRoot,
      liveCaptionOnly
        ? "frozen-live-caption-resource-build.json"
        : "frozen-resource-build.json",
    ),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        developmentOnly: true,
        distributionEligible: authority.distributionEligible,
        licenseDisposition: liveCaptionOnly
          ? senseVoiceAuthority.licenseDisposition
          : authority.licenseDisposition,
        setId: liveCaptionOnly ? senseVoiceAuthority.setId : authority.setId,
        ...(liveCaptionOnly
          ? {}
          : {
              contentKey: authority.contentKey,
              authoritySha256: createHash("sha256")
                .update(authorityBytes)
                .digest("hex"),
            }),
        liveCaptionAuthoritySha256: createHash("sha256")
          .update(senseVoiceAuthorityBytes)
          .digest("hex"),
        sources: sourceReceipts,
        members: memberReceipts,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

async function materializeSenseVoice(input: {
  authority: FrozenSenseVoiceAuthority;
  lock: FrozenSenseVoiceLock;
  outputRoot: string;
  temporaryRoot: string;
  sourceReceipts: Array<Record<string, unknown>>;
  memberReceipts: Array<Record<string, unknown>>;
}): Promise<void> {
  const { authority, lock, outputRoot, temporaryRoot } = input;
  const archivePath = path.join(temporaryRoot, "sensevoice-model.download");
  await freshDownload(authority.model.source, archivePath);
  await assertFileIdentity(
    archivePath,
    lock.archiveBytes,
    authority.model.archiveSha256,
  );
  input.sourceReceipts.push({
    id: "sensevoice-model-archive",
    source: authority.model.source,
    bytes: lock.archiveBytes,
    sha256: authority.model.archiveSha256,
  });
  const members = [
    {
      source: lock.archiveMembers.model,
      destination: "models/live-caption/model.int8.onnx",
      sha256: authority.model.modelSha256,
    },
    {
      source: lock.archiveMembers.tokens,
      destination: "models/live-caption/tokens.txt",
      sha256: authority.model.tokensSha256,
    },
  ];
  const extractionRoot = path.join(temporaryRoot, "sensevoice-model.members");
  await extractMembers(
    archivePath,
    extractionRoot,
    members.map((member) => member.source),
    "j",
  );
  for (const member of members) {
    const source = containedOutput(extractionRoot, member.source);
    await assertPrivateRegularFile(source, extractionRoot);
    const destination = containedOutput(outputRoot, member.destination);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    const bytes = (await stat(destination)).size;
    await assertFileSha256(destination, member.sha256);
    input.memberReceipts.push({
      path: member.destination,
      downloadId: "sensevoice-model-archive",
      archiveMember: member.source,
      bytes,
      sha256: member.sha256,
    });
  }

  const vadDownload = path.join(temporaryRoot, "sensevoice-vad.download");
  await freshDownload(authority.vad.source, vadDownload);
  await assertFileIdentity(vadDownload, lock.vadBytes, authority.vad.sha256);
  const vadDestination = containedOutput(
    outputRoot,
    "models/live-caption/silero_vad.onnx",
  );
  await mkdir(path.dirname(vadDestination), { recursive: true, mode: 0o700 });
  await copyFile(vadDownload, vadDestination);
  await assertFileIdentity(vadDestination, lock.vadBytes, authority.vad.sha256);
  input.sourceReceipts.push({
    id: "sensevoice-silero-vad",
    source: authority.vad.source,
    bytes: lock.vadBytes,
    sha256: authority.vad.sha256,
  });
  input.memberReceipts.push({
    path: "models/live-caption/silero_vad.onnx",
    downloadId: "sensevoice-silero-vad",
    bytes: lock.vadBytes,
    sha256: authority.vad.sha256,
  });
}

function validateSenseVoiceAuthority(raw: unknown): FrozenSenseVoiceAuthority {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("frozen SenseVoice authority is invalid");
  }
  const authority = raw as Partial<FrozenSenseVoiceAuthority>;
  const model = authority.model;
  const vad = authority.vad;
  const control = authority.control;
  if (
    authority.schemaVersion !== 1 ||
    authority.platform !== "macos" ||
    authority.architecture !== "arm64" ||
    authority.developmentPosture !== "DEVELOPMENT_ONLY" ||
    authority.status !== "PASS" ||
    authority.distributionEligible !== false ||
    authority.developmentEligible !== true ||
    authority.licenseDisposition !== "LOCAL_DEVELOPMENT_BENCHMARK_ONLY" ||
    typeof authority.setId !== "string" ||
    !authority.setId.startsWith("sensevoice-live-caption-macos-arm64-") ||
    !model ||
    !isOfficialSource(model.source) ||
    !isSha256(model.archiveSha256) ||
    model.modelRelativePath !== "model.int8.onnx" ||
    !isSha256(model.modelSha256) ||
    model.tokensRelativePath !== "tokens.txt" ||
    !isSha256(model.tokensSha256) ||
    !vad ||
    !isOfficialSource(vad.source) ||
    !isSha256(vad.sha256) ||
    !control ||
    control.runtime !== "sherpa-onnx-1.13.4-ort-1.27.0" ||
    control.provider !== "cpu" ||
    control.threads !== 2 ||
    control.concurrency !== 1 ||
    control.decodingMethod !== "greedy_search" ||
    control.language !== "auto" ||
    control.useInverseTextNormalization !== false ||
    control.maximumUtteranceSeconds !== 15 ||
    control.publishesTokenPartials !== false
  ) {
    throw new Error(
      "frozen SenseVoice authority does not match the macOS arm64 development contract",
    );
  }
  return authority as FrozenSenseVoiceAuthority;
}

function validateSenseVoiceLock(raw: unknown): FrozenSenseVoiceLock {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("frozen SenseVoice lock is invalid");
  }
  const lock = raw as Partial<FrozenSenseVoiceLock>;
  const archiveBytes = lock.archiveBytes;
  const vadBytes = lock.vadBytes;
  if (
    lock.schemaVersion !== 1 ||
    lock.target !== "darwin-arm64" ||
    !isSha256(lock.frozenReferenceSha256) ||
    !Number.isSafeInteger(archiveBytes) ||
    archiveBytes === undefined ||
    archiveBytes <= 0 ||
    !Number.isSafeInteger(vadBytes) ||
    vadBytes === undefined ||
    vadBytes <= 0 ||
    !lock.archiveMembers ||
    !safeRelativePath(lock.archiveMembers.model) ||
    !safeRelativePath(lock.archiveMembers.tokens)
  ) {
    throw new Error("frozen SenseVoice lock is invalid");
  }
  return lock as FrozenSenseVoiceLock;
}

function validateAuthority(raw: unknown): FrozenAuthority {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("frozen Sherpa authority is invalid");
  }
  const authority = raw as Partial<FrozenAuthority>;
  if (
    authority.schemaVersion !== 1 ||
    authority.platform !== "macos" ||
    authority.architecture !== "arm64" ||
    authority.distributionEligible !== false ||
    typeof authority.setId !== "string" ||
    !authority.setId.startsWith("sherpa-onnx-1.13.4-") ||
    !isSha256(authority.contentKey) ||
    typeof authority.licenseDisposition !== "string" ||
    !Array.isArray(authority.downloads) ||
    !Array.isArray(authority.files)
  ) {
    throw new Error(
      "frozen Sherpa authority does not match the macOS arm64 development contract",
    );
  }
  const downloadIds = new Set<string>();
  for (const download of authority.downloads) {
    if (
      !download ||
      typeof download.id !== "string" ||
      downloadIds.has(download.id) ||
      !isOfficialSource(download.source) ||
      !isSha256(download.sha256) ||
      !Number.isSafeInteger(download.bytes) ||
      download.bytes <= 0 ||
      (download.kind !== "file" && download.kind !== "tar.bz2")
    ) {
      throw new Error("frozen Sherpa download authority is invalid");
    }
    downloadIds.add(download.id);
  }
  const relativePaths = new Set<string>();
  for (const file of authority.files) {
    if (
      !file ||
      !safeRelativePath(file.relativePath) ||
      relativePaths.has(file.relativePath) ||
      !downloadIds.has(file.downloadId) ||
      (file.archiveMember !== undefined &&
        !safeRelativePath(file.archiveMember)) ||
      !isSha256(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      typeof file.licenseSpdx !== "string"
    ) {
      throw new Error("frozen Sherpa member authority is invalid");
    }
    relativePaths.add(file.relativePath);
  }
  return authority as FrozenAuthority;
}

function safeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("-") &&
    value.split("/").every((segment) => segment !== "" && segment !== "..")
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isOfficialSource(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname === "github.com";
}

function assertRuntimeLock(lock: string): void {
  const lines = lock.split(/\r?\n/);
  const start = lines.indexOf(`  ${runtimeArchive.package}:`);
  if (start < 0) throw new Error("root lock is missing sherpa_onnx_macos");
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[ ]{2}[a-zA-Z0-9_]+:$/.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  const packageLines = new Set(
    lines.slice(start + 1, end).map((line) => line.trim()),
  );
  if (
    !packageLines.has(`version: "${runtimeArchive.version}"`) ||
    !packageLines.has(`sha256: "${runtimeArchive.sha256}"`)
  ) {
    throw new Error("fresh Sherpa runtime authority disagrees with root lock");
  }
}

function containedOutput(root: string, relative: string): string {
  const candidate = path.resolve(root, relative);
  const inside = path.relative(root, candidate);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new Error("resource output escaped its staging root");
  }
  return candidate;
}

async function validatedSuppliedTemporaryRoot(value: string): Promise<string> {
  const candidate = path.resolve(value);
  const metadata = await lstat(candidate);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !path.basename(candidate).startsWith("voice2text-electron-sherpa.")
  ) {
    throw new Error("supplied Sherpa temporary root is invalid");
  }
  return candidate;
}

async function freshDownload(
  source: string,
  destination: string,
): Promise<void> {
  await run(
    "curl",
    [
      "--fail",
      "--location",
      "--show-error",
      "--progress-bar",
      "--output",
      destination,
      source,
    ],
    "inherit",
  );
}

async function extractMembers(
  archive: string,
  extractionRoot: string,
  members: string[],
  compression: "j" | "z",
): Promise<void> {
  if (
    members.length === 0 ||
    members.some((member) => !safeRelativePath(member))
  ) {
    throw new Error("archive extraction allowlist is invalid");
  }
  await mkdir(extractionRoot, { recursive: true, mode: 0o700 });
  await run(
    "tar",
    [`-x${compression}f`, archive, "-C", extractionRoot, ...members],
    "ignore",
  );
}

async function assertPrivateRegularFile(
  file: string,
  extractionRoot: string,
): Promise<void> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("archive member is not a private regular file");
  }
  const canonicalRoot = await realpath(extractionRoot);
  const canonicalFile = await realpath(file);
  const relative = path.relative(canonicalRoot, canonicalFile);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("archive member escaped its extraction root");
  }
}

async function assertFileIdentity(
  file: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<void> {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size !== expectedBytes) {
    throw new Error(`resource byte length mismatch: ${path.basename(file)}`);
  }
  if ((await sha256FileWithShasum(file)) !== expectedSha256) {
    throw new Error(`resource SHA-256 mismatch: ${path.basename(file)}`);
  }
}

async function assertFileSha256(
  file: string,
  expectedSha256: string,
): Promise<void> {
  if ((await sha256FileWithShasum(file)) !== expectedSha256) {
    throw new Error(`resource SHA-256 mismatch: ${path.basename(file)}`);
  }
}

async function run(
  command: string,
  arguments_: string[],
  stdout: "inherit" | "ignore",
): Promise<void> {
  const child = spawn(command, arguments_, {
    stdio: ["ignore", stdout, "inherit"],
  });
  await waitForExit(child, command);
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  label: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${String(code ?? signal)})`));
    });
  });
}
