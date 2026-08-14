import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const packagedIt =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  process.env.RUN_PACKAGED_AI_BOUNDARY === "1"
    ? it
    : it.skip;

describe("packaged macOS AI security boundary", () => {
  it("detects quoted sensitive keys in packaged evidence", () => {
    expect(hasSensitiveEvidenceKey('{"secret":"must-not-escape"}')).toBe(true);
    expect(hasSensitiveEvidenceKey('{"secretState":"missing"}')).toBe(false);
  });

  packagedIt(
    "uses packaged Main and private helper without network or consent for local settings",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "voice2text-packaged-ai-"));
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
        const output = path.join(evidenceRoot, "ai-boundary.json");
        const executable = path.resolve(
          "out/Voice2Text-darwin-arm64/Voice2Text.app/Contents/MacOS/Voice2Text",
        );
        expect(existsSync(executable)).toBe(true);

        const result = await launch({
          executable,
          appData,
          output,
          privateHome,
          privateTmp,
        });
        expect(result.exitCode, result.stderr).toBe(0);
        const evidence = JSON.parse(readFileSync(output, "utf8")) as Record<
          string,
          unknown
        >;
        expect(evidence).toEqual(
          expect.objectContaining({
            schemaVersion: 1,
            phase: "packaged-ai-local-boundary",
            transport: "inherited-stdio",
            providerId: "deepseek",
            modelId: "deepseek-chat",
            endpointIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            secretState: expect.stringMatching(/^(missing|denied|corrupt)$/),
            invalidEndpointRejected: true,
            networkRequestCount: 0,
            before: { consents: 0, jobs: 0, notes: 0 },
            after: { consents: 0, jobs: 0, notes: 0 },
            databaseUserVersion: 10,
            deviceSecurity: {
              kind: "device-security",
              fileVaultState: expect.stringMatching(
                /^(enabled|disabled|unknown)$/,
              ),
              applicationLayerEncryption: "not-claimed",
            },
          }),
        );
        const encoded = JSON.stringify(evidence);
        expect(hasSensitiveEvidenceKey(encoded)).toBe(false);
        expect(hasSensitiveEvidenceKey(result.stderr)).toBe(false);
        expect(statSync(privateHome).mode & 0o777).toBe(0o700);
        expect(statSync(privateTmp).mode & 0o777).toBe(0o700);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

function hasSensitiveEvidenceKey(value: string): boolean {
  return /["']?(?:secret|token|transcriptText|utterances)["']?\s*:/i.test(
    value,
  );
}

async function launch(options: {
  executable: string;
  appData: string;
  output: string;
  privateHome: string;
  privateTmp: string;
}): Promise<{ exitCode: number; stderr: string }> {
  const child = spawn(options.executable, [], {
    cwd: options.privateTmp,
    detached: true,
    env: {
      HOME: options.privateHome,
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: options.privateTmp,
      ELECTRON_ENABLE_LOGGING: "1",
      VOICE2TEXT_AI_BOUNDARY_SMOKE_APP_DATA: options.appData,
      VOICE2TEXT_AI_BOUNDARY_SMOKE_OUTPUT: options.output,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stderr, "utf8") < 32 * 1024) {
      stderr += chunk.toString("utf8");
    }
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      killProcessGroup(child.pid);
      reject(new Error(`packaged AI boundary timed out: ${stderr}`));
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
    throw new Error(`packaged AI boundary omitted evidence: ${stderr}`);
  }
  return { exitCode, stderr };
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
  throw new Error("packaged AI boundary left process-group descendants");
}
