import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MacOSNativeHelperClient } from "../../src/main/features/importing/macos_native_helper_client";
import {
  secureImportLimits,
  secureImportRequestSchema,
} from "../../src/shared/contracts/import_processing";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe.skipIf(process.platform !== "darwin")(
  "macOS native helper protocol lifecycle",
  () => {
    it.each(["invalid-hello", "handshake-timeout"] as const)(
      "kills and waits for the helper after %s",
      async (mode) => {
        const fixture = fakeHelper(mode);
        const client = new MacOSNativeHelperClient(fixture.executable, {
          handshakeTimeoutMs: 1_000,
        });

        const opening = client.openSession({
          exactSourcePaths: [],
          destinationRoots: [],
        });
        const rejected = expect(opening).rejects.toThrow();
        await waitForFile(fixture.pidPath);
        await rejected;
        expect(
          processExists(Number(readFileSync(fixture.pidPath, "utf8"))),
        ).toBe(false);
      },
    );

    it.each(["forged-result", "forged-error"] as const)(
      "rejects a %s frame that does not echo the session identity",
      async (mode) => {
        const fixture = fakeHelper(mode);
        const session = await new MacOSNativeHelperClient(
          fixture.executable,
        ).openSession({ exactSourcePaths: [], destinationRoots: [] });
        await expect(
          session.invokeRaw({ command: "cleanup-import-temporary" }),
        ).rejects.toThrow(/session identity/i);
        await session.close();
      },
    );

    it("bounds invokes and terminates the helper before rejecting", async () => {
      const fixture = fakeHelper("invoke-timeout");
      const session = await new MacOSNativeHelperClient(fixture.executable, {
        invokeTimeoutMs: 50,
      }).openSession({ exactSourcePaths: [], destinationRoots: [] });

      await expect(
        session.invokeRaw({ command: "no-response" }),
      ).rejects.toThrow(/timed out/i);
      expect(processExists(Number(readFileSync(fixture.pidPath, "utf8")))).toBe(
        false,
      );
      await session.close();
    });

    it("recovers only its declared capture root and rejects replay", async () => {
      const root = mkdtempSync(
        join(realpathSync(tmpdir()), "voice2text-capture-helper-"),
      );
      roots.push(root);
      const captureRoot = join(root, "captures");
      const capture = join(captureRoot, "session-recovery-123456");
      mkdirSync(capture, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(capture, "journal.json"),
        JSON.stringify({
          schemaVersion: 1,
          schema: "desktop-capture-session/v1",
          sessionId: "session-recovery-123456",
          state: "recording",
          captureMode: "dual_track",
          captureTimelineMs: 20,
          chunks: [],
          events: [],
        }),
      );
      const session = await new MacOSNativeHelperClient(
        nativeHelperPath(),
      ).openSession({
        exactSourcePaths: [],
        destinationRoots: [],
        captureSessionRoot: captureRoot,
      });
      try {
        await expect(session.captureRecover()).resolves.toEqual([
          expect.objectContaining({
            sessionId: "session-recovery-123456",
            state: "recoverable",
          }),
        ]);
        const replay = {
          command: "capture-recover",
          commandId: "capture-replay-123456",
        };
        await expect(session.invokeRaw(replay)).resolves.toMatchObject({
          type: "result",
        });
        await expect(session.invokeRaw(replay)).rejects.toThrow(
          /HELPER_COMMAND_REPLAYED/,
        );
        await expect(
          session.invokeRaw({
            command: "capture-recover",
            helperNonce: "0".repeat(64),
          }),
        ).rejects.toThrow(/HELPER_SESSION_REJECTED/);
        await expect(
          session.invokeRaw({ command: "capture-delete-root" }),
        ).rejects.toThrow(/HELPER_COMMAND_NOT_ALLOWLISTED/);
        await expect(
          session.captureDiscard("../outside", "discard-escape-123456"),
        ).rejects.toThrow(/CAPTURE_ARGUMENTS_INVALID/);
      } finally {
        await session.close();
      }
    });

    it("rejects capture commands without a capture capability", async () => {
      const session = await new MacOSNativeHelperClient(
        nativeHelperPath(),
      ).openSession({ exactSourcePaths: [], destinationRoots: [] });
      try {
        await expect(session.captureRecover()).rejects.toThrow(
          /HELPER_CAPABILITY_DENIED/,
        );
      } finally {
        await session.close();
      }
    });

    it("rejects a symbolic-link capture root during handshake", async () => {
      const root = mkdtempSync(
        join(realpathSync(tmpdir()), "voice2text-capture-link-"),
      );
      roots.push(root);
      const outside = join(root, "outside");
      mkdirSync(outside);
      const link = join(root, "capture-link");
      // A root capability is never allowed to acquire authority through a link.
      symlinkSync(outside, link);
      await expect(
        new MacOSNativeHelperClient(nativeHelperPath()).openSession({
          exactSourcePaths: [],
          destinationRoots: [],
          captureSessionRoot: link,
        }),
      ).rejects.toThrow();
    });
  },
);

it("rejects import limits outside the shared fixed envelope", () => {
  const valid = {
    sourcePath: "/tmp/source.wav",
    destinationRoot: "/tmp/profile-media",
    destinationId: "meeting-123456789abc",
    maxSourceBytes: secureImportLimits.maximumSourceBytes,
    minimumFreeBytes: secureImportLimits.maximumMinimumFreeBytes,
    temporaryStorageMultiplier: 8,
    maxDurationMs: secureImportLimits.maximumDurationMs,
  };
  expect(secureImportRequestSchema.safeParse(valid).success).toBe(true);
  expect(
    secureImportRequestSchema.safeParse({
      ...valid,
      maxSourceBytes: secureImportLimits.maximumSourceBytes + 1,
    }).success,
  ).toBe(false);
  expect(
    secureImportRequestSchema.safeParse({
      ...valid,
      minimumFreeBytes: secureImportLimits.maximumMinimumFreeBytes + 1,
    }).success,
  ).toBe(false);
  expect(
    secureImportRequestSchema.safeParse({
      ...valid,
      maxDurationMs: secureImportLimits.maximumDurationMs + 1,
    }).success,
  ).toBe(false);
});

function fakeHelper(
  mode:
    | "invalid-hello"
    | "handshake-timeout"
    | "forged-result"
    | "forged-error"
    | "invoke-timeout",
): { executable: string; pidPath: string } {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "voice2text-helper-client-"),
  );
  roots.push(root);
  const executable = join(root, "fake-helper.sh");
  const pidPath = join(root, "helper.pid");
  const helperNonce = "a".repeat(64);
  const sessionSetup = `
printf '%s\\n' '{"schemaVersion":1,"type":"hello","protocol":"voice2text-macos-helper/v1","transport":"inherited-stdio","helperNonce":"${helperNonce}"}'
IFS= read -r handshake
client_nonce=$(printf '%s' "$handshake" | /usr/bin/sed -E 's/.*"clientNonce":"([^"]+)".*/\\1/')
session_id=$(printf '%s' "$handshake" | /usr/bin/sed -E 's/.*"sessionId":"([^"]+)".*/\\1/')
printf '{"schemaVersion":1,"type":"ready","protocol":"voice2text-macos-helper/v1","transport":"inherited-stdio","helperNonce":"${helperNonce}","clientNonce":"%s","sessionId":"%s"}\\n' "$client_nonce" "$session_id"
IFS= read -r request
`;
  const behavior =
    mode === "invalid-hello"
      ? `printf '%s\\n' '{"schemaVersion":1,"type":"hello","protocol":"wrong","transport":"inherited-stdio","helperNonce":"${helperNonce}"}'
IFS= read -r never`
      : mode === "handshake-timeout"
        ? `printf '%s\\n' '{"schemaVersion":1,"type":"hello","protocol":"voice2text-macos-helper/v1","transport":"inherited-stdio","helperNonce":"${helperNonce}"}'
IFS= read -r handshake
IFS= read -r never`
        : mode === "invoke-timeout"
          ? `${sessionSetup}IFS= read -r never`
          : mode === "forged-result"
            ? `${sessionSetup}printf '%s\\n' '{"schemaVersion":1,"type":"result","helperNonce":"${"b".repeat(64)}","clientNonce":"forged","sessionId":"forged"}'`
            : `${sessionSetup}printf '%s\\n' '{"schemaVersion":1,"type":"error","helperNonce":"${"b".repeat(64)}","clientNonce":"forged","sessionId":"forged","code":"FORGED","message":"forged"}'`;
  writeFileSync(
    executable,
    `#!/bin/sh
set -eu
printf '%s\\n' "$$" > '${pidPath}'
${behavior}
`,
  );
  chmodSync(executable, 0o700);
  return { executable, pidPath };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      readFileSync(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function nativeHelperPath(): string {
  return join(
    import.meta.dirname,
    "../../../../packages/desktop_macos_native/.build/debug/desktop_macos_native_helper",
  );
}
