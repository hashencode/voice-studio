import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

import { describe, expect, it } from "vitest";

const packagedIt =
  process.env.RUN_PACKAGED_NATIVE_SECURITY_SMOKE === "1" ? it : it.skip;

describe.skipIf(process.platform !== "darwin")(
  "packaged macOS native security helper",
  () => {
    packagedIt(
      "uses the signed bundle helper for device-only secrets and FileVault truth",
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
        expect(() =>
          execFileSync("/usr/bin/codesign", ["--verify", "--strict", helper]),
        ).not.toThrow();

        const child = spawn(helper, [], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let helperStderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          helperStderr = `${helperStderr}${chunk.toString("utf8")}`.slice(
            -4_096,
          );
        });
        const frames = createInterface({ input: child.stdout });
        const pending: Array<(frame: Record<string, unknown>) => void> = [];
        const queued: Array<Record<string, unknown>> = [];
        frames.on("line", (line) => {
          const resolve = pending.shift();
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (resolve) resolve(frame);
          else queued.push(frame);
        });
        const nextFrame = async (): Promise<Record<string, unknown>> => {
          const queuedFrame = queued.shift();
          if (queuedFrame) return queuedFrame;
          return await new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("native helper frame timed out")),
              10_000,
            );
            pending.push((frame) => {
              clearTimeout(timeout);
              resolve(frame);
            });
          });
        };
        const send = (frame: Record<string, unknown>) => {
          child.stdin.write(`${JSON.stringify(frame)}\n`);
        };
        const hello = await nextFrame();
        expect(hello).toEqual(
          expect.objectContaining({
            schemaVersion: 1,
            type: "hello",
            protocol: "voice2text-macos-helper/v1",
            transport: "inherited-stdio",
            helperNonce: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        );
        const helperNonce = hello.helperNonce as string;
        const clientNonce = randomBytes(32).toString("hex");
        const sessionId = `security-smoke-${randomBytes(8).toString("hex")}`;
        const session = { helperNonce, clientNonce, sessionId };
        send({
          schemaVersion: 1,
          command: "handshake",
          ...session,
          capabilities: {
            exactSourcePaths: [],
            destinationRoots: [],
            captureSessionRoot: null,
          },
        });
        expect(await nextFrame()).toEqual(
          expect.objectContaining({
            schemaVersion: 1,
            type: "ready",
            protocol: "voice2text-macos-helper/v1",
            transport: "inherited-stdio",
            ...session,
          }),
        );

        const providerId = `smoke.${randomBytes(10).toString("hex")}`;
        const secret = randomBytes(24).toString("base64url");
        const invoke = async (
          command: string,
          commandId: string,
          request?: Record<string, unknown>,
        ) => {
          send({
            schemaVersion: 1,
            command,
            commandId,
            ...session,
            ...(request ? { request } : {}),
          });
          try {
            return await nextFrame();
          } catch {
            throw new Error(
              `${command} timed out (exit=${String(child.exitCode)}, stderr=${JSON.stringify(helperStderr)})`,
            );
          }
        };
        const id = (label: string) =>
          `${label}-${randomBytes(10).toString("hex")}`;
        const requireKeychainMutation =
          process.env.RUN_PACKAGED_NATIVE_SECURITY_KEYCHAIN_MUTATION === "1";
        let stored = false;

        try {
          const replaced = await invoke("secret-replace", id("replace"), {
            providerId,
            secret: `  ${secret}\n`,
          });
          expect(JSON.stringify(replaced)).not.toContain(secret);
          if (requireKeychainMutation) {
            expect(replaced).toEqual(
              expect.objectContaining({
                type: "result",
                command: "secret-replace",
                secret: { schemaVersion: 1, state: "stored" },
                ...session,
              }),
            );
            stored = true;
            expect(
              await invoke("secret-read", id("read"), { providerId }),
            ).toEqual(
              expect.objectContaining({
                type: "result",
                command: "secret-read",
                secret: { schemaVersion: 1, state: "available", secret },
                ...session,
              }),
            );
            expect(
              await invoke("secret-delete", id("delete"), { providerId }),
            ).toEqual(
              expect.objectContaining({
                type: "result",
                command: "secret-delete",
                secret: { schemaVersion: 1, state: "deleted" },
                ...session,
              }),
            );
            stored = false;
            expect(
              await invoke("secret-read", id("missing"), { providerId }),
            ).toEqual(
              expect.objectContaining({
                type: "result",
                secret: { schemaVersion: 1, state: "missing" },
              }),
            );
          } else {
            expect(replaced).toEqual(
              expect.objectContaining({
                type: "error",
                code: expect.stringMatching(
                  /^(KEYCHAIN_UNAVAILABLE|KEYCHAIN_OPERATION_FAILED)$/,
                ),
                ...session,
              }),
            );
          }

          const fileVaultCommandId = id("filevault");
          expect(await invoke("filevault-status", fileVaultCommandId)).toEqual(
            expect.objectContaining({
              type: "result",
              security: {
                schemaVersion: 1,
                kind: "device-security",
                capability: "filevault",
                state: expect.stringMatching(/^(enabled|disabled|unknown)$/),
                applicationLayerEncryption: "not-claimed",
              },
            }),
          );
          expect(await invoke("filevault-status", fileVaultCommandId)).toEqual(
            expect.objectContaining({
              type: "error",
              code: "HELPER_COMMAND_REPLAYED",
            }),
          );
          expect(
            await invoke("secret-read", id("invalid"), {
              providerId: "INVALID PROVIDER",
            }),
          ).toEqual(
            expect.objectContaining({
              type: "error",
              code: "KEYCHAIN_ARGUMENTS_INVALID",
              message: "provider identifier is invalid",
            }),
          );
          expect(await invoke("keychain-dump", id("forbidden"))).toEqual(
            expect.objectContaining({
              type: "error",
              code: "HELPER_COMMAND_NOT_ALLOWLISTED",
            }),
          );
        } finally {
          if (stored) {
            await invoke("secret-delete", id("cleanup"), {
              providerId,
            }).catch(() => undefined);
          }
          child.stdin.end();
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              child.kill("SIGTERM");
              reject(new Error("native helper did not exit"));
            }, 5_000);
            child.once("exit", () => {
              clearTimeout(timeout);
              resolve();
            });
          });
        }
      },
      60_000,
    );
  },
);
