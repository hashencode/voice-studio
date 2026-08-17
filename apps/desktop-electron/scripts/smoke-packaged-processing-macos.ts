import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ProcessingSmokeEvidence,
  ProcessingSmokeReferenceBindings,
} from "../src/main/application/processing_smoke_evidence";

const maximumRunMs = 15 * 60 * 1_000;
const maximumLogBytes = 64 * 1024;
const referenceSources = [
  "apps/desktop-electron/tests/fixtures/flutter-reference/source/apps/desktop/lib/features/processing/desktop_processing_repository.dart",
  "packages/desktop_sherpa_worker/bin/desktop_sherpa_worker.dart",
  "packages/desktop_sherpa_worker/lib/src/sherpa_desktop_processing_engine.dart",
] as const;

export interface PackagedWorkstationEvidence {
  schemaVersion: 1;
  protocol: "voice2text-u7-packaged-workstation/v1";
  packaged: boolean;
  audioId: number;
  generationId: number;
  segmentCount: number;
  manualRevisionSurvivedRetry: boolean;
  productionRetryCompleted: boolean;
  productionCancelCompleted: boolean;
  retryTerminal: { state: string; attempt: number };
  cancelTerminal: { state: string; attempt: number };
  searchResultCount: number;
  playback: {
    initialized: boolean;
    positionMs: number;
    speed: number;
    pathRedacted: boolean;
  };
  exported: Array<{ format: string; fileName: string; bytes: number }>;
  rendererBoundary: string;
  rendererDomReady: boolean;
  rendererPreloadDriven: boolean;
  sidebarTasksDriven: boolean;
  importProgressObserved: boolean;
  operationStates: string[];
}

export async function runPackagedProcessingSmoke(): Promise<ProcessingSmokeEvidence> {
  return (await runPackagedSmoke(false)).processing;
}

export async function runPackagedLocalWorkstationSmoke(): Promise<PackagedWorkstationEvidence> {
  const result = await runPackagedSmoke(true);
  if (!result.workstation)
    throw new Error("packaged workstation evidence is missing");
  return result.workstation;
}

async function runPackagedSmoke(captureWorkstation: boolean): Promise<{
  processing: ProcessingSmokeEvidence;
  workstation: PackagedWorkstationEvidence | null;
}> {
  const electronRoot = path.resolve(".");
  const repositoryRoot = path.resolve(electronRoot, "../..");
  const appRoot = path.join(
    electronRoot,
    "out/Voice2Text-darwin-arm64/Voice2Text.app",
  );
  const executable = path.join(appRoot, "Contents/MacOS/Voice2Text");
  const sourcePath = path.join(repositoryRoot, "benchmark/audio/en.wav");
  const temporaryRoot = await mkdtemp(
    path.join(await realpath(os.homedir()), ".voice2text-app-processing-"),
  );
  const processTemporaryPath = path.join(temporaryRoot, "tmp");
  await mkdir(processTemporaryPath, { mode: 0o700 });
  const appDataPath = path.join(processTemporaryPath, "app-data");
  const evidenceDirectory = path.join(processTemporaryPath, "evidence");
  const outputPath = path.join(evidenceDirectory, "processing-evidence.json");
  const workstationOutputPath = path.join(
    evidenceDirectory,
    "workstation-evidence.json",
  );
  await mkdir(appDataPath, { mode: 0o700 });
  await mkdir(evidenceDirectory, { mode: 0o700 });
  try {
    const referenceBindings: ProcessingSmokeReferenceBindings = {
      fixtureSha256: await sha256File(sourcePath),
      dartSources: await Promise.all(
        referenceSources.map(async (relativePath) => ({
          path: relativePath,
          sha256: await sha256File(path.join(repositoryRoot, relativePath)),
        })),
      ),
    };
    const child = spawn(executable, [], {
      cwd: os.tmpdir(),
      detached: true,
      env: {
        ELECTRON_ENABLE_LOGGING: "1",
        HOME: temporaryRoot,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: processTemporaryPath,
        VOICE2TEXT_PROCESSING_SMOKE_APP_DATA: appDataPath,
        VOICE2TEXT_PROCESSING_SMOKE_OUTPUT: outputPath,
        VOICE2TEXT_PROCESSING_SMOKE_SOURCE: sourcePath,
        VOICE2TEXT_PROCESSING_SMOKE_REFERENCE_BINDINGS:
          JSON.stringify(referenceBindings),
        ...(captureWorkstation
          ? { VOICE2TEXT_WORKSTATION_SMOKE_OUTPUT: workstationOutputPath }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    collectBounded(child.stdout, stdout);
    collectBounded(child.stderr, stderr);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child.pid, "SIGTERM");
      setTimeout(
        () => terminateProcessGroup(child.pid, "SIGKILL"),
        5_000,
      ).unref();
    }, maximumRunMs);
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? -1));
    }).finally(() => clearTimeout(timeout));
    if (timedOut) throw new Error("packaged processing smoke timed out");
    if (exitCode !== 0) {
      throw new Error(
        `packaged processing app exited with ${exitCode}: ${Buffer.concat(stderr).toString("utf8")}`,
      );
    }
    const raw = await readFile(outputPath);
    if (raw.byteLength > 32_768) {
      throw new Error("packaged processing evidence exceeded its byte limit");
    }
    const receipt = JSON.parse(raw.toString("utf8")) as ProcessingSmokeEvidence;
    if (
      receipt.schemaVersion !== 1 ||
      !/^[a-f0-9]{64}$/.test(receipt.projectionSha256) ||
      receipt.projection?.referenceBindings.fixtureSha256 !==
        referenceBindings.fixtureSha256 ||
      !receipt.transcriptNonEmpty ||
      receipt.segmentCount <= 0
    ) {
      throw new Error("packaged processing evidence is invalid");
    }
    let workstation: PackagedWorkstationEvidence | null = null;
    if (captureWorkstation) {
      const workstationRaw = await readFile(workstationOutputPath);
      if (workstationRaw.byteLength > 32_768) {
        throw new Error(
          "packaged workstation evidence exceeded its byte limit",
        );
      }
      workstation = JSON.parse(
        workstationRaw.toString("utf8"),
      ) as PackagedWorkstationEvidence;
      if (
        workstation.schemaVersion !== 1 ||
        workstation.protocol !== "voice2text-u7-packaged-workstation/v1" ||
        workstation.packaged !== true ||
        !workstation.manualRevisionSurvivedRetry ||
        !workstation.productionRetryCompleted ||
        !workstation.productionCancelCompleted ||
        workstation.retryTerminal.state !== "completed" ||
        workstation.retryTerminal.attempt < 2 ||
        workstation.cancelTerminal.state !== "canceled" ||
        workstation.cancelTerminal.attempt < 1 ||
        workstation.searchResultCount < 1 ||
        workstation.exported.length !== 5 ||
        workstation.playback.pathRedacted !== true ||
        workstation.rendererBoundary !==
          "typed-preload-opaque-identifiers-only" ||
        !workstation.rendererDomReady ||
        !workstation.rendererPreloadDriven ||
        !workstation.sidebarTasksDriven ||
        !workstation.importProgressObserved ||
        !["queued", "running"].every((state) =>
          workstation!.operationStates.includes(state),
        )
      ) {
        throw new Error("packaged workstation evidence is invalid");
      }
    }
    return { processing: receipt, workstation };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function collectBounded(
  stream: NodeJS.ReadableStream | null,
  chunks: Buffer[],
): void {
  let bytes = 0;
  stream?.on("data", (chunk: Buffer | string) => {
    if (bytes >= maximumLogBytes) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const accepted = buffer.subarray(0, maximumLogBytes - bytes);
    chunks.push(accepted);
    bytes += accepted.byteLength;
  });
}

function terminateProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function sha256File(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  console.log(JSON.stringify(await runPackagedProcessingSmoke(), null, 2));
}
