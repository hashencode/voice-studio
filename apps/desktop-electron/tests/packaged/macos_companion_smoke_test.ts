import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AUDIO_SCHEMA_VERSION } from "../../src/main/storage/audio_database";

const packagedIt =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  process.env.RUN_PACKAGED_COMPANION_SMOKE === "1"
    ? it
    : it.skip;

describe("packaged macOS companion transfer", () => {
  packagedIt(
    "runs Dart sender through packaged Main and restarts with a durable receipt",
    async () => {
      const root = mkdtempSync(
        path.join(tmpdir(), "voice2text-packaged-companion-"),
      );
      const children = new Set<ChildProcess>();
      try {
        chmodSync(root, 0o700);
        const privateHome = path.join(root, "home");
        const privateTmp = path.join(root, "tmp");
        const evidenceRoot = path.join(privateTmp, "evidence");
        const appData = path.join(privateTmp, "app-data");
        for (const directory of [
          privateHome,
          privateTmp,
          evidenceRoot,
          appData,
        ]) {
          mkdirSync(directory, { recursive: true, mode: 0o700 });
        }
        const executable = path.resolve(
          "out/Voice2Text-darwin-arm64/Voice2Text.app/Contents/MacOS/Voice2Text",
        );
        expect(existsSync(executable)).toBe(true);
        const source = path.join(privateTmp, "companion-source.wav");
        writeFileSync(source, makePcmWave(), { mode: 0o600 });
        const sourceSha256 = createHash("sha256")
          .update(readFileSync(source))
          .digest("hex");
        const identitySeed = Buffer.from(
          Array.from({ length: 32 }, (_, index) => index),
        );
        const mobileIdentitySeed = Buffer.from(
          Array.from({ length: 32 }, (_, index) => index + 1),
        );
        const credentialStorePath = path.join(
          evidenceRoot,
          "companion-peer-credential.bin",
        );
        const mobileTrustPath = path.join(
          evidenceRoot,
          "mobile-paired-trust.bin",
        );
        const transferId = "transfer-packaged-companion-1";
        const checkpointOutput = path.join(
          evidenceRoot,
          "companion-checkpoint-unused.json",
        );
        const checkpointReady = path.join(
          evidenceRoot,
          "companion-checkpoint-ready.json",
        );
        const checkpointRequest = path.join(
          evidenceRoot,
          "companion-checkpoint-request.json",
        );
        writeRequest(checkpointRequest, {
          schemaVersion: 1,
          phase: "pair-checkpoint",
          appDataPath: appData,
          outputPath: checkpointOutput,
          readyPath: checkpointReady,
          credentialStorePath,
          identitySeedBase64: identitySeed.toString("base64"),
          expectedTransferId: transferId,
          expectedSourceSha256: sourceSha256,
        });
        const checkpointApp = launchPackaged({
          executable,
          requestPath: checkpointRequest,
          privateHome,
          privateTmp,
          children,
        });
        const checkpointReceiver = await Promise.race([
          waitForJson(checkpointReady, 90_000),
          checkpointApp.completion.then((failed) => {
            throw new Error(
              `packaged companion exited before readiness\n${failed.stderr}`,
            );
          }),
        ]);
        const pairingInvite = checkpointReceiver.pairingInvite as Record<
          string,
          unknown
        >;
        const paired = await runDartPairCheckpoint({
          port: Number(checkpointReceiver.port),
          source,
          transferId,
          sourceSha256,
          targetDeviceId: String(checkpointReceiver.desktopDeviceId),
          targetFingerprint: String(checkpointReceiver.desktopFingerprint),
          targetPublicKeyBase64: String(
            checkpointReceiver.desktopPublicKeyBase64,
          ),
          pairingId: String(pairingInvite.pairingId),
          shortCode: String(pairingInvite.shortCode),
          targetEphemeralPublicKeyBase64: String(
            pairingInvite.responderEphemeralPublicKey,
          ),
          expiresAtMs: Number(pairingInvite.expiresAtMs),
          mobileIdentitySeed,
          mobileTrustPath,
          privateHome,
          privateTmp,
          children,
        });
        expect(paired).toMatchObject({
          paired: true,
          checkpointed: true,
          sourceSha256,
          targetFingerprint: checkpointReceiver.desktopFingerprint,
          mobileFingerprint: expect.stringMatching(/^[A-Z2-7]{20,64}$/),
          manifestCreatedAtMs: expect.any(Number),
        });
        expect(statSync(credentialStorePath).mode & 0o777).toBe(0o600);
        expect(statSync(mobileTrustPath).mode & 0o777).toBe(0o600);
        expect(statSync(mobileTrustPath).size).toBe(32);
        expect(privateFileSha256(credentialStorePath)).toBe(
          privateFileSha256(mobileTrustPath),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        killProcessGroup(checkpointApp.child.pid);
        await checkpointApp.completion;
        expect(existsSync(checkpointOutput)).toBe(false);

        const runOutput = path.join(evidenceRoot, "companion-run.json");
        const runReady = path.join(evidenceRoot, "companion-run-ready.json");
        const runRequest = path.join(
          evidenceRoot,
          "companion-run-request.json",
        );
        writeRequest(runRequest, {
          schemaVersion: 1,
          phase: "run",
          appDataPath: appData,
          outputPath: runOutput,
          readyPath: runReady,
          credentialStorePath,
          identitySeedBase64: identitySeed.toString("base64"),
          expectedTransferId: transferId,
          expectedSourceSha256: sourceSha256,
        });
        const running = launchPackaged({
          executable,
          requestPath: runRequest,
          privateHome,
          privateTmp,
          children,
        });
        const ready = await waitForJson(runReady, 90_000);
        const sender = await runDartSender({
          mode: "resume",
          port: Number(ready.port),
          source,
          transferId,
          sourceSha256,
          targetDeviceId: String(ready.desktopDeviceId),
          targetFingerprint: String(ready.desktopFingerprint),
          targetPublicKeyBase64: String(ready.desktopPublicKeyBase64),
          mobileFingerprint: String(paired.mobileFingerprint),
          manifestCreatedAtMs: Number(paired.manifestCreatedAtMs),
          credentialPath: mobileTrustPath,
          privateHome,
          privateTmp,
          children,
          receiverStderr: running.stderr,
        });
        expect(sender).toEqual(
          expect.objectContaining({
            schemaVersion: 1,
            transferIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            sourceSha256,
            resumed: true,
            sentBytesAfterRestart: readFileSync(source).byteLength - 4_096,
            senderMayDeleteSource: true,
            recordingId: expect.any(Number),
          }),
        );
        const run = await running.completion;
        expect(run.exitCode, run.stderr).toBe(0);
        const committed = JSON.parse(readFileSync(runOutput, "utf8"));
        expect(committed).toEqual(
          expect.objectContaining({
            schemaVersion: 1,
            phase: "committed",
            protocol: "companion-audio-transfer/v2",
            sourceSha256,
            normalizedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            receiptSignatureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            senderDeleteAllowed: true,
            missingChunkCount: 0,
            databaseUserVersion: AUDIO_SCHEMA_VERSION,
          }),
        );

        const verifyOutput = path.join(evidenceRoot, "companion-verify.json");
        const verifyReady = path.join(
          evidenceRoot,
          "companion-verify-ready.json",
        );
        const verifyRequest = path.join(
          evidenceRoot,
          "companion-verify-request.json",
        );
        writeRequest(verifyRequest, {
          schemaVersion: 1,
          phase: "verify",
          appDataPath: appData,
          outputPath: verifyOutput,
          readyPath: verifyReady,
          credentialStorePath,
          identitySeedBase64: identitySeed.toString("base64"),
          expectedTransferId: transferId,
          expectedSourceSha256: sourceSha256,
        });
        const verifying = launchPackaged({
          executable,
          requestPath: verifyRequest,
          privateHome,
          privateTmp,
          children,
        });
        const verified = await verifying.completion;
        expect(verified.exitCode, verified.stderr).toBe(0);
        expect(JSON.parse(readFileSync(verifyOutput, "utf8"))).toEqual(
          expect.objectContaining({
            phase: "restart-verified",
            sourceSha256,
            senderDeleteAllowed: true,
            missingChunkCount: 0,
            databaseUserVersion: AUDIO_SCHEMA_VERSION,
          }),
        );
        const evidenceText = [
          readFileSync(runOutput, "utf8"),
          readFileSync(verifyOutput, "utf8"),
          JSON.stringify(sender),
          run.stderr,
          verified.stderr,
        ].join("\n");
        expect(evidenceText).not.toMatch(
          /["']?(?:secret|credential|token|transcriptText|utterances)["']?\s*:/i,
        );
        expect(evidenceText).not.toContain(identitySeed.toString("base64"));
        expect(evidenceText).not.toContain(
          mobileIdentitySeed.toString("base64"),
        );
        mobileIdentitySeed.fill(0);
        expect(statSync(privateHome).mode & 0o777).toBe(0o700);
        expect(statSync(privateTmp).mode & 0o777).toBe(0o700);
      } finally {
        for (const child of children) killProcessGroup(child.pid);
        await Promise.all(
          [...children].map((child) => ensureProcessGroupExited(child.pid)),
        );
        rmSync(root, { recursive: true, force: true });
      }
    },
    15 * 60 * 1_000,
  );
});

function writeRequest(pathname: string, value: Record<string, unknown>): void {
  writeFileSync(pathname, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function launchPackaged(options: {
  executable: string;
  requestPath: string;
  privateHome: string;
  privateTmp: string;
  children: Set<ChildProcess>;
}): {
  child: ChildProcess;
  completion: Promise<{ exitCode: number; stderr: string }>;
  stderr: () => string;
} {
  const child = spawn(options.executable, [], {
    cwd: options.privateTmp,
    detached: true,
    env: {
      HOME: options.privateHome,
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: options.privateTmp,
      ELECTRON_ENABLE_LOGGING: "1",
      VOICE2TEXT_COMPANION_SMOKE_REQUEST: options.requestPath,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  options.children.add(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stderr, "utf8") < 32 * 1024) {
      stderr += chunk.toString("utf8");
    }
  });
  const completion = waitForExit(child, 12 * 60 * 1_000, () => stderr).then(
    async (exitCode) => {
      options.children.delete(child);
      await ensureProcessGroupExited(child.pid);
      return { exitCode, stderr };
    },
  );
  return { child, completion, stderr: () => stderr };
}

async function runDartPairCheckpoint(options: {
  port: number;
  source: string;
  transferId: string;
  sourceSha256: string;
  targetDeviceId: string;
  targetFingerprint: string;
  targetPublicKeyBase64: string;
  pairingId: string;
  shortCode: string;
  targetEphemeralPublicKeyBase64: string;
  expiresAtMs: number;
  mobileIdentitySeed: Buffer;
  mobileTrustPath: string;
  privateHome: string;
  privateTmp: string;
  children: Set<ChildProcess>;
}): Promise<Record<string, unknown>> {
  const packageRoot = path.resolve("../../packages/companion_protocol");
  const dartExecutable = resolveDartExecutable();
  const trustFd = openSync(
    options.mobileTrustPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let child: ChildProcess;
  try {
    child = spawn(
      dartExecutable,
      [
        "run",
        "tool/packaged_sender.dart",
        "pair-checkpoint",
        String(options.port),
        options.source,
        options.transferId,
        options.sourceSha256,
        options.targetDeviceId,
        options.targetFingerprint,
        options.targetPublicKeyBase64,
        options.pairingId,
        options.shortCode,
        options.targetEphemeralPublicKeyBase64,
        String(options.expiresAtMs),
        "3",
      ],
      {
        cwd: packageRoot,
        detached: true,
        env: {
          HOME: options.privateHome,
          LANG: "en_US.UTF-8",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          TMPDIR: options.privateTmp,
        },
        stdio: ["pipe", "pipe", "pipe", trustFd],
      },
    );
  } finally {
    closeSync(trustFd);
  }
  options.children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stdout, "utf8") < 16 * 1024) stdout += chunk;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stderr, "utf8") < 16 * 1024) stderr += chunk;
  });
  child.stdin?.end(options.mobileIdentitySeed);
  const exitCode = await waitForExit(child, 5 * 60 * 1_000, () => stderr);
  options.children.delete(child);
  await ensureProcessGroupExited(child.pid);
  if (exitCode !== 0) {
    rmSync(options.mobileTrustPath, { force: true });
    throw new Error(`packaged Dart pairing failed: ${stderr}`);
  }
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function runDartSender(options: {
  mode: "resume";
  port: number;
  source: string;
  transferId: string;
  sourceSha256: string;
  targetDeviceId: string;
  targetFingerprint: string;
  targetPublicKeyBase64: string;
  mobileFingerprint: string;
  manifestCreatedAtMs: number;
  credentialPath: string;
  privateHome: string;
  privateTmp: string;
  children: Set<ChildProcess>;
  receiverStderr: () => string;
}): Promise<Record<string, unknown>> {
  const packageRoot = path.resolve("../../packages/companion_protocol");
  const dartExecutable = resolveDartExecutable();
  const credentialStat = statSync(options.credentialPath, {
    bigint: false,
  });
  if (
    !credentialStat.isFile() ||
    credentialStat.nlink !== 1 ||
    credentialStat.size !== 32 ||
    (credentialStat.mode & 0o777) !== 0o600
  ) {
    throw new Error("mobile trust file is not a private 32-byte credential");
  }
  const credential = readFileSync(options.credentialPath);
  const child = spawn(
    dartExecutable,
    [
      "run",
      "tool/packaged_sender.dart",
      options.mode,
      String(options.port),
      options.source,
      options.transferId,
      options.sourceSha256,
      options.targetDeviceId,
      options.targetFingerprint,
      options.targetPublicKeyBase64,
      options.mobileFingerprint,
      String(options.manifestCreatedAtMs),
    ],
    {
      cwd: packageRoot,
      detached: true,
      env: {
        HOME: options.privateHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: options.privateTmp,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  options.children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stdout, "utf8") < 16 * 1024) stdout += chunk;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stderr, "utf8") < 16 * 1024) stderr += chunk;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      if (!child.stdin) {
        reject(new Error("packaged Dart sender stdin is unavailable"));
        return;
      }
      child.stdin.end(credential, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } finally {
    credential.fill(0);
  }
  const exitCode = await waitForExit(child, 5 * 60 * 1_000, () => stderr);
  options.children.delete(child);
  await ensureProcessGroupExited(child.pid);
  if (exitCode !== 0) {
    throw new Error(
      `packaged Dart sender failed: ${stderr}\n${options.receiverStderr()}`,
    );
  }
  return JSON.parse(stdout) as Record<string, unknown>;
}

function privateFileSha256(pathname: string): string {
  const bytes = readFileSync(pathname);
  try {
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}

function resolveDartExecutable(): string {
  const configured = process.env.VOICE2TEXT_DART_EXECUTABLE;
  if (configured !== undefined) {
    if (!path.isAbsolute(configured)) {
      throw new Error("VOICE2TEXT_DART_EXECUTABLE must be absolute");
    }
    accessSync(configured, constants.X_OK);
    return configured;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "dart");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue until the first executable Dart SDK on the parent PATH.
    }
  }
  throw new Error("Dart executable is unavailable on the parent PATH");
}

async function waitForJson(
  pathname: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pathname)) {
      return JSON.parse(readFileSync(pathname, "utf8")) as Record<
        string,
        unknown
      >;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("packaged companion ready receipt timed out");
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
  stderr: () => string,
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killProcessGroup(child.pid);
      reject(new Error(`packaged companion process timed out: ${stderr()}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

function makePcmWave(): Buffer {
  const sampleRate = 16_000;
  const samples = sampleRate;
  const dataBytes = samples * 2;
  const wave = Buffer.alloc(44 + dataBytes);
  wave.write("RIFF", 0, "ascii");
  wave.writeUInt32LE(36 + dataBytes, 4);
  wave.write("WAVEfmt ", 8, "ascii");
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36, "ascii");
  wave.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples; index += 1) {
    wave.writeInt16LE(Math.round(Math.sin(index / 20) * 4_000), 44 + index * 2);
  }
  return wave;
}

function killProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function ensureProcessGroupExited(
  pid: number | undefined,
): Promise<void> {
  if (!pid) return;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      if (code !== "EPERM") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  killProcessGroup(pid);
  throw new Error("packaged companion smoke left process-group descendants");
}
