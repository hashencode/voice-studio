import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import {
  capturePreflightSchema,
  captureSnapshotSchema,
  microphoneTestSnapshotSchema,
  secureImportReceiptSchema,
  secureImportRequestSchema,
  type SecureImportReceipt,
  type SecureImportRequest,
  type CapturePreflight,
  type CaptureSnapshot,
  type CaptureStartCommand,
  type CaptureControlCommand,
  type MicrophoneTestSnapshot,
} from "../../../shared/contracts";

export interface HelperCapabilities {
  exactSourcePaths: string[];
  destinationRoots: string[];
  captureSessionRoot?: string;
  companionDiscovery?: true;
}

interface HelperFrame {
  schemaVersion?: unknown;
  type?: unknown;
  code?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

export class MacOSNativeHelperClient {
  constructor(
    private readonly executable: string,
    private readonly options: {
      handshakeTimeoutMs?: number;
      invokeTimeoutMs?: number;
    } = {},
  ) {}

  async openSession(
    capabilities: HelperCapabilities,
  ): Promise<MacOSNativeHelperSession> {
    if (
      capabilities.exactSourcePaths.length > 32 ||
      capabilities.destinationRoots.length > 8 ||
      (capabilities.captureSessionRoot !== undefined &&
        (!path.isAbsolute(capabilities.captureSessionRoot) ||
          Buffer.byteLength(capabilities.captureSessionRoot, "utf8") > 2_048))
    ) {
      throw new Error("helper capability set exceeded the session limit");
    }
    const child = spawn(this.executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      detached: false,
    });
    const protocol = new HelperLineProtocol(child);
    try {
      const timeoutMs = boundedTimeout(
        this.options.handshakeTimeoutMs,
        2_000,
        30_000,
        "helper handshake timeout",
      );
      const hello = await withTimeout(
        protocol.next(),
        timeoutMs,
        "helper hello timed out",
      );
      if (
        hello.schemaVersion !== 1 ||
        hello.type !== "hello" ||
        hello.protocol !== "voice2text-macos-helper/v1" ||
        hello.transport !== "inherited-stdio" ||
        typeof hello.helperNonce !== "string" ||
        !/^[a-f0-9]{64}$/.test(hello.helperNonce)
      ) {
        throw new Error("helper hello failed protocol validation");
      }
      const helperNonce = hello.helperNonce;
      const clientNonce = randomBytes(32).toString("hex");
      const sessionId = `session-${randomUUID()}`;
      protocol.send({
        schemaVersion: 1,
        command: "handshake",
        helperNonce,
        clientNonce,
        sessionId,
        capabilities,
      });
      const ready = await withTimeout(
        protocol.next(),
        timeoutMs,
        "helper handshake timed out",
      );
      if (
        ready.schemaVersion !== 1 ||
        ready.type !== "ready" ||
        ready.helperNonce !== helperNonce ||
        ready.clientNonce !== clientNonce ||
        ready.sessionId !== sessionId ||
        ready.transport !== "inherited-stdio"
      ) {
        throw new Error("helper handshake was rejected");
      }
      return new MacOSNativeHelperSession(
        protocol,
        helperNonce,
        clientNonce,
        sessionId,
        boundedTimeout(
          this.options.invokeTimeoutMs,
          5 * 60 * 60 * 1_000,
          6 * 60 * 60 * 1_000,
          "helper invoke timeout",
        ),
      );
    } catch (error) {
      await protocol.terminate();
      throw error;
    }
  }
}

export class MacOSNativeHelperSession {
  readonly transport = "inherited-stdio" as const;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly protocol: HelperLineProtocol,
    readonly helperNonce: string,
    readonly clientNonce: string,
    private readonly sessionId: string,
    private readonly invokeTimeoutMs: number,
  ) {}

  async secureImport(
    request: SecureImportRequest,
  ): Promise<SecureImportReceipt> {
    const response = await this.invoke({
      command: "secure-import",
      request: secureImportRequestSchema.parse(request),
    });
    return secureImportReceiptSchema.parse(response.receipt);
  }

  async discard(path: string, destinationRoot: string): Promise<void> {
    await this.invoke({ command: "discard-import", path, destinationRoot });
  }

  async cleanup(destinationRoot: string): Promise<number> {
    const response = await this.invoke({
      command: "cleanup-import-temporary",
      destinationRoot,
    });
    if (
      !Number.isSafeInteger(response.removed) ||
      Number(response.removed) < 0
    ) {
      throw new Error("helper cleanup response was invalid");
    }
    return Number(response.removed);
  }

  async capturePreflight(request: {
    minimumFreeBytes: number;
    captionModelAvailable: boolean;
    requestPermissions: boolean;
  }): Promise<CapturePreflight> {
    const response = await this.invoke({
      command: "capture-preflight",
      request,
    });
    return capturePreflightSchema.parse(response.capture);
  }

  async captureStart(command: CaptureStartCommand): Promise<CaptureSnapshot> {
    const response = await this.invoke({
      command: "capture-start",
      commandId: command.idempotencyKey,
      request: {
        sessionId: command.sessionId,
        minimumFreeBytes: command.minimumFreeBytes,
        microphoneDeviceId: command.microphoneDeviceId,
      },
    });
    return captureSnapshotSchema.parse(response.capture);
  }

  async captureControl(
    command: CaptureControlCommand,
  ): Promise<CaptureSnapshot> {
    const response = await this.invoke({
      command: `capture-${command.action}`,
      commandId: command.idempotencyKey,
      request: { sessionId: command.sessionId },
    });
    return captureSnapshotSchema.parse(response.capture);
  }

  async captureLifecycle(
    action: "system-sleep" | "system-wake",
    sessionId: string,
    commandId: string,
  ): Promise<CaptureSnapshot> {
    const response = await this.invoke({
      command: `capture-${action}`,
      commandId,
      request: { sessionId },
    });
    return captureSnapshotSchema.parse(response.capture);
  }

  async captureSnapshot(sessionId: string): Promise<CaptureSnapshot> {
    const response = await this.invoke({
      command: "capture-snapshot",
      request: { sessionId },
    });
    return captureSnapshotSchema.parse(response.capture);
  }

  async captureRecover(): Promise<CaptureSnapshot[]> {
    const response = await this.invoke({ command: "capture-recover" });
    return captureSnapshotSchema.array().max(256).parse(response.captures);
  }

  async captureDiscard(sessionId: string, commandId: string): Promise<void> {
    await this.invoke({
      command: "capture-discard",
      commandId,
      request: { sessionId },
    });
  }

  async startMicrophoneTest(
    testId: string,
    microphoneDeviceId?: string,
  ): Promise<MicrophoneTestSnapshot> {
    const response = await this.invoke({
      command: "microphone-test-start",
      request: { testId, microphoneDeviceId },
    });
    return microphoneTestSnapshotSchema.parse(response.microphoneTest);
  }

  async microphoneTestSnapshot(
    testId: string,
  ): Promise<MicrophoneTestSnapshot> {
    const response = await this.invoke({
      command: "microphone-test-snapshot",
      request: { testId },
    });
    return microphoneTestSnapshotSchema.parse(response.microphoneTest);
  }

  async stopMicrophoneTest(testId: string): Promise<MicrophoneTestSnapshot> {
    const response = await this.invoke({
      command: "microphone-test-stop",
      request: { testId },
    });
    return microphoneTestSnapshotSchema.parse(response.microphoneTest);
  }

  async invokeRaw(command: Record<string, unknown>): Promise<HelperFrame> {
    return await this.invoke(command);
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
    await this.protocol.close();
  }

  private async invoke(command: Record<string, unknown>): Promise<HelperFrame> {
    const next = this.queue
      .catch(() => undefined)
      .then(async () => {
        let response: HelperFrame;
        try {
          this.protocol.send({
            schemaVersion: 1,
            helperNonce: this.helperNonce,
            clientNonce: this.clientNonce,
            sessionId: this.sessionId,
            commandId: randomUUID(),
            ...command,
          });
          response = await withTimeout(
            this.protocol.next(),
            this.invokeTimeoutMs,
            "helper invoke timed out",
          );
        } catch (error) {
          await this.protocol.terminate();
          throw error;
        }
        if (
          response.schemaVersion !== 1 ||
          response.helperNonce !== this.helperNonce ||
          response.clientNonce !== this.clientNonce ||
          response.sessionId !== this.sessionId
        ) {
          await this.protocol.terminate();
          throw new Error("helper response session identity is invalid");
        }
        if (response.type === "error") {
          throw new Error(
            `${typeof response.code === "string" ? response.code : "HELPER_FAILED"}: ${typeof response.message === "string" ? response.message : "helper request failed"}`,
          );
        }
        if (response.type !== "result") {
          await this.protocol.terminate();
          throw new Error("helper response type is invalid");
        }
        return response;
      });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }
}

class HelperLineProtocol {
  private readonly lines: Interface;
  private readonly waiting: Array<{
    resolve(value: HelperFrame): void;
    reject(error: Error): void;
  }> = [];
  private readonly buffered: HelperFrame[] = [];
  private terminalError: Error | null = null;
  private stderrBytes = 0;
  private readonly closed: Promise<void>;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.accept(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.byteLength;
      if (this.stderrBytes > 64 * 1024)
        void this.terminate().catch((error: Error) => this.fail(error));
    });
    child.once("error", (error) => this.fail(error));
    this.closed = new Promise((resolve) => {
      child.once("close", (code) => {
        if (code !== 0)
          this.fail(new Error(`native helper exited with ${String(code)}`));
        else this.fail(new Error("native helper closed"));
        resolve();
      });
    });
  }

  send(value: Record<string, unknown>): void {
    const line = JSON.stringify(value);
    if (Buffer.byteLength(line, "utf8") > 64 * 1024) {
      throw new Error("helper request exceeded the byte limit");
    }
    this.child.stdin.write(`${line}\n`);
  }

  async next(): Promise<HelperFrame> {
    const buffered = this.buffered.shift();
    if (buffered) return buffered;
    if (this.terminalError) throw this.terminalError;
    return await new Promise((resolve, reject) =>
      this.waiting.push({ resolve, reject }),
    );
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end();
    }
    await this.closed;
    this.lines.close();
  }

  async terminate(): Promise<void> {
    this.lines.close();
    this.child.stdin.destroy();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
    }
    await this.closed;
  }

  private accept(line: string): void {
    if (Buffer.byteLength(line, "utf8") > 64 * 1024) {
      this.fail(new Error("helper response exceeded the byte limit"));
      void this.terminate().catch((error: Error) => this.fail(error));
      return;
    }
    let frame: HelperFrame;
    try {
      frame = JSON.parse(line) as HelperFrame;
    } catch {
      this.fail(new Error("helper emitted invalid JSON"));
      void this.terminate().catch((error: Error) => this.fail(error));
      return;
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve(frame);
    else this.buffered.push(frame);
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }
}

function boundedTimeout(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return timeout;
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
