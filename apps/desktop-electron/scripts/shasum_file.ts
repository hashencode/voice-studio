import { spawn } from "node:child_process";
import path from "node:path";

const sha256Pattern = /^([a-f0-9]{64})\s+.+\n?$/;
const defaultTimeoutMs = 5 * 60 * 1_000;
const maximumOutputBytes = 1024;

export interface ShasumOptions {
  command?: string;
  timeoutMs?: number;
}

export async function sha256FileWithShasum(
  file: string,
  options: ShasumOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("SHA-256 deadline is invalid");
  }
  const absoluteFile = path.resolve(file);
  const command = options.command ?? "/usr/bin/shasum";
  const child = spawn(command, ["-a", "256", absoluteFile], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let terminalError: Error | null = null;
  const append = (target: Buffer[], chunk: Buffer): void => {
    outputBytes += chunk.byteLength;
    if (outputBytes > maximumOutputBytes) {
      terminalError ??= new Error("SHA-256 subprocess exceeded output limit");
      child.kill("SIGKILL");
      return;
    }
    target.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));

  const timer = setTimeout(() => {
    terminalError ??= new Error(
      `SHA-256 subprocess exceeded ${timeoutMs}ms deadline`,
    );
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (terminalError) return finish(terminalError);
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        return finish(
          new Error(
            `SHA-256 subprocess failed (${String(code ?? signal)})${detail ? `: ${detail}` : ""}`,
          ),
        );
      }
      finish();
    });
  });

  const output = Buffer.concat(stdout).toString("utf8");
  const match = sha256Pattern.exec(output);
  if (!match) throw new Error("SHA-256 subprocess returned malformed output");
  return match[1]!;
}
