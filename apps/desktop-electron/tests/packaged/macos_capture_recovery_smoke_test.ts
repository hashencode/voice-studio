import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MacOSNativeHelperClient } from "../../src/main/features/importing/macos_native_helper_client";
import { ELECTRON_SCHEMA_VERSION } from "../../src/main/storage/database";

const packagedIt =
  process.env.RUN_PACKAGED_CAPTURE_SMOKE === "1" ? it : it.skip;

describe("packaged macOS capture recovery", () => {
  packagedIt(
    "uses only the signed app-bundle helper and recovers authority",
    async () => {
      const appRoot = path.resolve(
        "out/Voice2Text-darwin-arm64/Voice2Text.app",
      );
      const helper = path.join(
        appRoot,
        "Contents/Resources/native/macos/bin/desktop_macos_native_helper",
      );
      expect(() =>
        execFileSync("/usr/bin/codesign", [
          "--verify",
          "--deep",
          "--strict",
          appRoot,
        ]),
      ).not.toThrow();
      expect(helper).not.toContain("app.asar");
      expect(
        execFileSync("/usr/bin/codesign", ["--verify", "--strict", helper]),
      ).toBeTruthy();
      const dependencies = execFileSync("/usr/bin/otool", ["-L", helper], {
        encoding: "utf8",
      });
      expect(dependencies).not.toContain("FlutterMacOS");
      const strings = execFileSync("/usr/bin/strings", [helper], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      expect(strings).not.toContain(
        "voice2text-flutter/packages/desktop_macos_native",
      );

      const root = mkdtempSync(
        path.join(tmpdir(), "voice2text-packaged-capture-"),
      );
      try {
        chmodSync(root, 0o700);
        const privateHome = path.join(root, "home");
        const privateTmp = path.join(root, "tmp");
        const privateEvidence = path.join(privateTmp, "evidence");
        mkdirSync(privateHome, { mode: 0o700 });
        mkdirSync(privateTmp, { mode: 0o700 });
        mkdirSync(privateEvidence, { mode: 0o700 });
        const appData = path.join(privateTmp, "app-data");
        mkdirSync(appData, { mode: 0o700 });
        const executable = path.join(appRoot, "Contents/MacOS/Voice2Text");
        const initializeReceipt = path.join(
          privateEvidence,
          "capture-initialize.json",
        );
        const initialized = await launchPackagedCapture({
          executable,
          appData,
          output: initializeReceipt,
          phase: "initialize",
          privateHome,
          privateTmp,
        });
        expect(initialized.exitCode).toBe(85);
        expect(JSON.parse(readFileSync(initializeReceipt, "utf8"))).toEqual(
          expect.objectContaining({
            phase: "profile-initialized",
            databaseUserVersion: ELECTRON_SCHEMA_VERSION,
            transport: "inherited-stdio",
          }),
        );
        if (process.env.RUN_PACKAGED_CAPTURE_INITIALIZE_ONLY === "1") return;
        const captureRoot = path.join(
          appData,
          "voice2text-electron/v1/workspaces/capture",
        );
        const sessionId = "session-packaged-123456";
        const sessionRoot = path.join(captureRoot, sessionId);
        const trackRoot = path.join(sessionRoot, "system");
        const captionRoot = path.join(sessionRoot, "caption");
        mkdirSync(trackRoot, { recursive: true, mode: 0o700 });
        mkdirSync(captionRoot, { mode: 0o700 });
        const chunk = Buffer.from("bounded packaged capture authority\n");
        const chunkPath = path.join(trackRoot, "chunk-000000.caf");
        writeFileSync(chunkPath, chunk, { mode: 0o600 });
        const chunkSha256 = createHash("sha256").update(chunk).digest("hex");
        const captionSpool = Buffer.alloc(32_000);
        writeFileSync(
          path.join(captionRoot, "live-caption.pcmspool"),
          captionSpool,
          { mode: 0o600 },
        );
        const captionSpoolSha256 = createHash("sha256")
          .update(captionSpool)
          .digest("hex");
        writeFileSync(
          path.join(sessionRoot, "journal.json"),
          JSON.stringify({
            schemaVersion: 1,
            schema: "desktop-capture-session/v1",
            sessionId,
            state: "recording",
            captureMode: "dual_track",
            captureTimelineMs: 1_000,
            tracks: [
              {
                kind: "system_audio",
                healthy: true,
                sampleRate: 48_000,
                channels: 2,
                format: "float32",
              },
              {
                kind: "microphone",
                healthy: true,
                sampleRate: 48_000,
                channels: 1,
                format: "float32",
              },
            ],
            chunks: [
              {
                track: "system_audio",
                sequence: 0,
                startMs: 0,
                endMs: 1_000,
                relativePath: "system/chunk-000000.caf",
                bytes: chunk.byteLength,
                sha256: chunkSha256,
                finalized: true,
              },
            ],
            events: [],
            spool: {
              relativePath: "caption/live-caption.pcmspool",
              format: "s16le",
              sampleRate: 16_000,
              channels: 1,
              frameDurationMs: 100,
              disposable: true,
              complete: true,
              formalEligible: true,
              bytes: captionSpool.byteLength,
              sha256: captionSpoolSha256,
              durationMs: 1_000,
              captureTimelineMs: 1_000,
              gapCount: 0,
            },
          }),
          { mode: 0o600 },
        );

        const session = await new MacOSNativeHelperClient(helper, {
          handshakeTimeoutMs: 10_000,
        }).openSession({
          exactSourcePaths: [],
          destinationRoots: [],
          captureSessionRoot: captureRoot,
        });
        try {
          const recovered = await session.captureRecover();
          expect(recovered).toEqual([
            expect.objectContaining({
              sessionId,
              state: "recoverable",
              finalizedChunkCount: 1,
              invalidFinalizedChunks: 0,
              quarantinedTailChunks: 0,
              journalSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
          ]);
          expect(
            createHash("sha256").update(readFileSync(chunkPath)).digest("hex"),
          ).toBe(chunkSha256);
        } finally {
          await session.close();
        }

        expect(
          await directInvocationExit(helper, privateHome, privateTmp),
        ).toBe(64);

        const crashReceipt = path.join(privateEvidence, "capture-crash.json");
        const crash = await launchPackagedCapture({
          executable,
          appData,
          output: crashReceipt,
          phase: "crash",
          privateHome,
          privateTmp,
        });
        expect(crash.exitCode).toBe(86);
        expect(JSON.parse(readFileSync(crashReceipt, "utf8"))).toEqual(
          expect.objectContaining({
            phase: "recovered-before-crash",
            recoveryReceiptCount: 1,
            transport: "inherited-stdio",
          }),
        );

        const verifyReceipt = path.join(privateEvidence, "capture-verify.json");
        const verified = await launchPackagedCapture({
          executable,
          appData,
          output: verifyReceipt,
          phase: "verify",
          privateHome,
          privateTmp,
        });
        expect(verified.exitCode).toBe(0);
        const evidence = JSON.parse(
          readFileSync(verifyReceipt, "utf8"),
        ) as Record<string, unknown>;
        expect(evidence).toEqual(
          expect.objectContaining({
            phase: "recovered-kept-after-restart",
            transport: "inherited-stdio",
            recoveryReceiptCount: 1,
            trackCount: 2,
            chunkCount: 1,
            receiptCount: 2,
            databaseUserVersion: ELECTRON_SCHEMA_VERSION,
            recordingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            journalSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            sessionIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            quitPolicy: {
              defaultAction: "继续录制",
              cancelAction: "继续录制",
              offersDiscard: false,
            },
            quitLifecycle: {
              beforeQuitAttempts: 2,
              continueCanceledTeardown: true,
              stopCalls: 1,
              stopReceiptObservedBeforeTeardown: true,
              databaseOpenBeforeTeardown: true,
            },
          }),
        );
        expect(JSON.stringify(evidence)).not.toContain(sessionId);
        expect(statSync(privateHome).mode & 0o777).toBe(0o700);
        expect(statSync(privateTmp).mode & 0o777).toBe(0o700);
        expect(
          createHash("sha256")
            .update(
              readFileSync(
                path.join(
                  appData,
                  "voice2text-electron/v1/database/meetings.sqlite3",
                ),
              ),
            )
            .digest("hex"),
        ).toMatch(/^[a-f0-9]{64}$/);
        expect(
          execFileSync("/usr/bin/find", [appRoot, "-name", "FlutterMacOS*"], {
            encoding: "utf8",
          }).trim(),
        ).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

async function directInvocationExit(
  helper: string,
  privateHome: string,
  privateTmp: string,
): Promise<number> {
  const child = spawn(helper, [], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      HOME: privateHome,
      TMPDIR: privateTmp,
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
    },
  });
  child.stdin.end();
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      killProcessGroup(child.pid);
      reject(new Error("direct helper invocation timed out"));
    }, 3_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      void ensureProcessGroupExited(child.pid).then(
        () => resolve(code ?? -1),
        reject,
      );
    });
  });
}

async function launchPackagedCapture(options: {
  executable: string;
  appData: string;
  output: string;
  phase: "initialize" | "crash" | "verify";
  privateHome: string;
  privateTmp: string;
}): Promise<{ exitCode: number }> {
  const child = spawn(options.executable, [], {
    cwd: options.privateTmp,
    detached: true,
    env: {
      HOME: options.privateHome,
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: options.privateTmp,
      ELECTRON_ENABLE_LOGGING: "1",
      VOICE2TEXT_CAPTURE_SMOKE_APP_DATA: options.appData,
      VOICE2TEXT_CAPTURE_SMOKE_OUTPUT: options.output,
      VOICE2TEXT_CAPTURE_SMOKE_PHASE: options.phase,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      killProcessGroup(child.pid);
      reject(
        new Error(`packaged capture ${options.phase} timed out: ${stderr}`),
      );
    }, 90_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      void ensureProcessGroupExited(child.pid).then(
        () => resolve(code ?? -1),
        reject,
      );
    });
  });
  if (!existsSync(options.output)) {
    throw new Error(
      `packaged capture ${options.phase} omitted evidence: ${stderr}`,
    );
  }
  return { exitCode };
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
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  killProcessGroup(pid);
  throw new Error(`packaged capture process group ${pid} left descendants`);
}
