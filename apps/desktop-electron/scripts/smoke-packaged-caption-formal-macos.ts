import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const maximumLogBytes = 64 * 1024;

export interface PackagedCaptionFormalReceipt {
  schemaVersion: 1;
  packaged: true;
  sessionIdentitySha256: string;
  draft: {
    state: "flushed";
    utteranceCount: number;
    backlogBytes: number;
  };
  formal: {
    generationId: number;
    attempt: 1;
    state: "completed";
    errorCode: null;
  };
  database: {
    processingJobCount: 1;
    publicationCount: 1;
    formalAttemptCount: 1;
    processingAttempt: number;
  };
  media: {
    sourceSha256: string;
    outputSha256: string;
    outputBytes: number;
  };
  resource: {
    manifestSha256: string;
    liveCaptionModelSha256: string;
    liveCaptionRuntimeSha256: string;
    formalModelSha256: string;
    formalRuntimeSha256: string;
  };
  renderer: {
    snapshotVisibleThroughPreload: true;
    retryMethodVisibleThroughPreload: true;
  };
  restart: {
    formalState: "completed";
    generationId: number;
    snapshotVisibleThroughPreload: true;
  };
}

export async function runPackagedCaptionFormalSmoke(): Promise<PackagedCaptionFormalReceipt> {
  const electronRoot = path.resolve(".");
  const repositoryRoot = path.resolve(electronRoot, "../..");
  const executable = path.join(
    electronRoot,
    "out/Voice2Text-darwin-arm64/Voice2Text.app/Contents/MacOS/Voice2Text",
  );
  const sourceFixture = path.join(repositoryRoot, "benchmark/audio/en.wav");
  const temporaryRoot = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "voice2text-caption-formal-"),
  );
  const homePath = path.join(temporaryRoot, "home");
  const processTemporaryPath = path.join(temporaryRoot, "tmp");
  const appDataPath = path.join(processTemporaryPath, "app-data");
  const evidenceDirectory = path.join(processTemporaryPath, "evidence");
  const evidencePath = path.join(evidenceDirectory, "caption-formal.json");
  const privateSourcePath = path.join(processTemporaryPath, "source.wav");
  await Promise.all(
    [homePath, processTemporaryPath, appDataPath, evidenceDirectory].map(
      async (directory) => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
      },
    ),
  );
  await copyFile(sourceFixture, privateSourcePath);
  await chmod(privateSourcePath, 0o600);
  try {
    await runPackagedPhase({
      executable,
      homePath,
      processTemporaryPath,
      appDataPath,
      evidencePath,
      sourcePath: privateSourcePath,
      phase: "run",
      timeoutMs: 8 * 60_000,
    });
    await runPackagedPhase({
      executable,
      homePath,
      processTemporaryPath,
      appDataPath,
      evidencePath,
      sourcePath: privateSourcePath,
      phase: "verify",
      timeoutMs: 90_000,
    });
    const raw = await readFile(evidencePath);
    return parsePackagedCaptionFormalReceipt(raw);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function parsePackagedCaptionFormalReceipt(
  raw: Buffer | string,
): PackagedCaptionFormalReceipt {
  const encoded = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
  if (encoded.byteLength > 32_768) {
    throw new Error("packaged caption formal evidence exceeded its bound");
  }
  const serialized = encoded.toString("utf8");
  if (/"(?:transcriptText|utterances|text)"\s*:/i.test(serialized)) {
    throw new Error("packaged caption formal evidence exposed transcript text");
  }
  const receipt = JSON.parse(serialized) as PackagedCaptionFormalReceipt;
  assertReceipt(receipt);
  return receipt;
}

async function runPackagedPhase(input: {
  executable: string;
  homePath: string;
  processTemporaryPath: string;
  appDataPath: string;
  evidencePath: string;
  sourcePath: string;
  phase: "run" | "verify";
  timeoutMs: number;
}): Promise<void> {
  const child = spawn(input.executable, [], {
    cwd: input.processTemporaryPath,
    detached: true,
    env: {
      ELECTRON_ENABLE_LOGGING: "1",
      HOME: input.homePath,
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: input.processTemporaryPath,
      VOICE2TEXT_CAPTION_FORMAL_SMOKE_APP_DATA: input.appDataPath,
      VOICE2TEXT_CAPTION_FORMAL_SMOKE_OUTPUT: input.evidencePath,
      VOICE2TEXT_CAPTION_FORMAL_SMOKE_SOURCE: input.sourcePath,
      VOICE2TEXT_CAPTION_FORMAL_SMOKE_PHASE: input.phase,
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
  }, input.timeoutMs);
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? -1));
    }).finally(() => clearTimeout(timeout));
    await assertProcessGroupExited(child.pid);
    if (timedOut) {
      throw new Error(`packaged caption formal ${input.phase} timed out`);
    }
    if (exitCode !== 0) {
      throw new Error(
        `packaged caption formal ${input.phase} exited with ${exitCode}: ${Buffer.concat(stderr).toString("utf8")}`,
      );
    }
  } finally {
    clearTimeout(timeout);
    terminateProcessGroup(child.pid, "SIGTERM");
    await assertProcessGroupExited(child.pid);
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

async function assertProcessGroupExited(
  pid: number | undefined,
): Promise<void> {
  if (!pid) return;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
  }
  terminateProcessGroup(pid, "SIGKILL");
  throw new Error("packaged caption formal process group remained alive");
}

function assertReceipt(receipt: PackagedCaptionFormalReceipt): void {
  const sha = /^[a-f0-9]{64}$/;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.packaged !== true ||
    receipt.draft.state !== "flushed" ||
    receipt.draft.utteranceCount < 1 ||
    receipt.formal.state !== "completed" ||
    receipt.formal.attempt !== 1 ||
    !Number.isSafeInteger(receipt.formal.generationId) ||
    receipt.database.processingJobCount !== 1 ||
    receipt.database.publicationCount !== 1 ||
    receipt.database.formalAttemptCount !== 1 ||
    receipt.database.processingAttempt !== 1 ||
    !receipt.renderer.snapshotVisibleThroughPreload ||
    !receipt.renderer.retryMethodVisibleThroughPreload ||
    receipt.restart.formalState !== "completed" ||
    receipt.restart.generationId !== receipt.formal.generationId ||
    !receipt.restart.snapshotVisibleThroughPreload ||
    ![
      receipt.sessionIdentitySha256,
      receipt.media.sourceSha256,
      receipt.media.outputSha256,
      receipt.resource.manifestSha256,
      receipt.resource.liveCaptionModelSha256,
      receipt.resource.liveCaptionRuntimeSha256,
      receipt.resource.formalModelSha256,
      receipt.resource.formalRuntimeSha256,
    ].every((value) => sha.test(value))
  ) {
    throw new Error("packaged caption formal evidence is invalid");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  console.log(JSON.stringify(await runPackagedCaptionFormalSmoke(), null, 2));
}
