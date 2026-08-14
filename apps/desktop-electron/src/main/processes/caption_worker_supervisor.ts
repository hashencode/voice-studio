import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  adaptCaptionWorkerEvent,
  captionWorkerErrorSchema,
  captionWorkerReadySchema,
  captionWorkerRequestSchema,
  type AdaptedCaptionWorkerEvent,
  type CaptionWorkerFence,
} from "./caption_worker_protocol";
import {
  assertAuthorizedResourceCommand,
  type ResolvedResourceCommand,
} from "../resources/resource_catalog";

const MAXIMUM_LINE_BYTES = 1024 * 1024;
const MAXIMUM_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAXIMUM_STDERR_BYTES = 256 * 1024;
const MAXIMUM_EVENTS_PER_SECOND = 50;
export const captionWorkerDeadlines = Object.freeze({
  readyMs: 30_000,
  openMs: 10_000,
  pollMs: 30_000,
  flushMs: 10 * 60_000,
});

type TerminalEvent = Extract<
  AdaptedCaptionWorkerEvent,
  { type: "sessionReady" | "pollComplete" | "sessionComplete" }
>;

interface PendingResponse {
  expected: TerminalEvent["type"];
  resolve(value: TerminalEvent): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class CaptionWorkerSupervisor {
  private stdout = Buffer.alloc(0);
  private totalOutputBytes = 0;
  private stderrBytes = 0;
  private pending: PendingResponse | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly readyPromise: Promise<void>;
  private utteranceWork: Promise<void> = Promise.resolve();
  private eventWindowStartedMs = Date.now();
  private eventWindowCount = 0;
  private closed = false;
  private failure: Error | null = null;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly fence: CaptionWorkerFence,
    private readonly onUtterance: (
      event: Extract<AdaptedCaptionWorkerEvent, { type: "utterance" }>,
    ) => void | Promise<void>,
    private readonly onSilence: (
      event: Extract<AdaptedCaptionWorkerEvent, { type: "silence" }>,
    ) => void | Promise<void>,
    private readonly timeoutOverrideMs: number | undefined,
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimeout = setTimeout(() => {
        this.fail(new Error("caption worker ready deadline exceeded"));
      }, this.timeoutOverrideMs ?? captionWorkerDeadlines.readyMs);
    });
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.byteLength;
      if (this.stderrBytes > MAXIMUM_STDERR_BYTES) {
        this.fail(new Error("caption worker stderr exceeded the byte limit"));
      }
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" || (!this.failure && !this.closed)) {
        this.fail(error);
      }
    });
    child.once("error", (error) => this.fail(error));
    child.once("close", (code) => {
      this.closed = true;
      if (this.failure) return;
      if (this.readyReject) {
        this.readyReject(new Error("caption worker exited before ready"));
      }
      this.rejectPending(
        new Error(`caption worker exited unexpectedly with ${String(code)}`),
      );
    });
  }

  static async launch(options: {
    command: ResolvedResourceCommand;
    workspaceRoot: string;
    sessionRoot: string;
    fence: CaptionWorkerFence;
    offsetBytes: number;
    firstSequence: number;
    onUtterance: CaptionWorkerSupervisor["onUtterance"];
    onSilence?: CaptionWorkerSupervisor["onSilence"];
    requestTimeoutMs?: number;
  }): Promise<CaptionWorkerSupervisor> {
    await assertAuthorizedResourceCommand(options.command);
    const canonicalWorkspace = await realpath(options.workspaceRoot);
    const canonicalSession = await realpath(options.sessionRoot);
    const relative = path.relative(canonicalWorkspace, canonicalSession);
    if (
      relative.length === 0 ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      (await lstat(canonicalSession)).isSymbolicLink()
    ) {
      throw new Error("caption session root escaped its workspace capability");
    }
    const fixtureArguments = options.command.args.filter((argument) =>
      argument.startsWith("--fixture-root="),
    );
    const fixtureRoot =
      fixtureArguments.length === 1
        ? await realpath(fixtureArguments[0]!.slice("--fixture-root=".length))
        : null;
    if (
      options.command.operation !== "live-caption" ||
      fixtureRoot !== canonicalSession
    ) {
      throw new Error("caption command escaped its session-root capability");
    }
    const child = spawn(options.command.executable, [...options.command.args], {
      cwd: canonicalSession,
      detached: process.platform !== "win32",
      env: minimalCaptionEnvironment(canonicalSession),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const supervisor = new CaptionWorkerSupervisor(
      child,
      options.fence,
      options.onUtterance,
      options.onSilence ?? (() => undefined),
      options.requestTimeoutMs,
    );
    try {
      await supervisor.waitUntilReady();
      await supervisor.request(
        {
          schemaVersion: 1,
          type: "openSession",
          sessionId: options.fence.sessionId,
          generationId: options.fence.generationId,
          spoolRelativePath: "caption/live-caption.pcmspool",
          offsetBytes: options.offsetBytes,
          firstSequence: options.firstSequence,
        },
        "sessionReady",
        captionWorkerDeadlines.openMs,
      );
      return supervisor;
    } catch (error) {
      await supervisor.close().catch(() => undefined);
      throw error;
    }
  }

  async poll(): Promise<TerminalEvent> {
    return await this.request(
      {
        schemaVersion: 1,
        type: "poll",
        sessionId: this.fence.sessionId,
      },
      "pollComplete",
      captionWorkerDeadlines.pollMs,
    );
  }

  async flush(): Promise<TerminalEvent> {
    return await this.request(
      {
        schemaVersion: 1,
        type: "flush",
        sessionId: this.fence.sessionId,
      },
      "sessionComplete",
      captionWorkerDeadlines.flushMs,
    );
  }

  async close(): Promise<void> {
    try {
      if (!this.closed && !this.failure && !this.child.stdin.destroyed) {
        this.write({ schemaVersion: 1, type: "shutdown" });
      }
      if (!this.child.stdin.destroyed) this.child.stdin.end();
      if (!this.closed) await waitForClose(this.child, 1_000);
    } finally {
      await terminateProcessGroup(this.child, 500);
    }
  }

  private async waitUntilReady(): Promise<void> {
    if (this.failure) throw this.failure;
    await this.readyPromise;
  }

  private async request(
    request: unknown,
    expected: PendingResponse["expected"],
    deadlineMs: number,
  ): Promise<TerminalEvent> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("caption worker is closed");
    if (this.pending)
      throw new Error("caption worker request is already active");
    const response = new Promise<TerminalEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(new Error("caption worker request deadline exceeded"));
      }, this.timeoutOverrideMs ?? deadlineMs);
      this.pending = { expected, resolve, reject, timeout };
    });
    this.write(request);
    return await response;
  }

  private write(request: unknown): void {
    const value = captionWorkerRequestSchema.parse(request);
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > MAXIMUM_LINE_BYTES) {
      throw new Error("caption worker request exceeded the byte limit");
    }
    if (this.child.stdin.destroyed) {
      throw new Error("caption worker stdin is closed");
    }
    this.child.stdin.write(line, (error) => {
      if (error) this.fail(error);
    });
  }

  private consume(chunk: Buffer): void {
    if (this.failure) return;
    this.totalOutputBytes += chunk.byteLength;
    if (this.totalOutputBytes > MAXIMUM_OUTPUT_BYTES) {
      this.fail(new Error("caption worker output exceeded the byte limit"));
      return;
    }
    this.stdout = Buffer.concat([this.stdout, chunk]);
    let newline = this.stdout.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.stdout.subarray(0, newline);
      this.stdout = this.stdout.subarray(newline + 1);
      if (line.byteLength > 0) this.parseLine(line);
      newline = this.stdout.indexOf(0x0a);
    }
    if (this.stdout.byteLength > MAXIMUM_LINE_BYTES) {
      this.fail(new Error("caption worker frame exceeded the byte limit"));
    }
  }

  private parseLine(line: Buffer): void {
    if (line.byteLength > MAXIMUM_LINE_BYTES) {
      this.fail(new Error("caption worker frame exceeded the byte limit"));
      return;
    }
    try {
      this.enforceEventRate();
      const raw: unknown = JSON.parse(line.toString("utf8"));
      if ((raw as { type?: unknown })?.type === "ready") {
        captionWorkerReadySchema.parse(raw);
        if (!this.readyResolve)
          throw new Error("caption worker replayed ready");
        clearTimeout(this.readyTimeout!);
        this.readyTimeout = null;
        const resolve = this.readyResolve;
        this.readyResolve = null;
        this.readyReject = null;
        resolve();
        return;
      }
      if ((raw as { type?: unknown })?.type === "error") {
        const error = captionWorkerErrorSchema.parse(raw);
        throw new Error(`caption worker reported ${error.code}`);
      }
      const event = adaptCaptionWorkerEvent(raw, this.fence);
      if (event.type === "utterance" || event.type === "silence") {
        this.utteranceWork = this.utteranceWork.then(async () => {
          if (event.type === "utterance") await this.onUtterance(event);
          else await this.onSilence(event);
        });
        void this.utteranceWork.catch((error: unknown) =>
          this.fail(
            new Error("caption utterance callback failed", { cause: error }),
          ),
        );
        return;
      }
      const pending = this.pending;
      if (!pending || pending.expected !== event.type) {
        throw new Error("caption worker response was unexpected");
      }
      clearTimeout(pending.timeout);
      this.pending = null;
      void this.utteranceWork.then(
        () => pending.resolve(event),
        (error: unknown) =>
          pending.reject(
            new Error("caption utterance callback failed", { cause: error }),
          ),
      );
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new Error("caption worker emitted an invalid frame"),
      );
    }
  }

  private enforceEventRate(): void {
    const now = Date.now();
    if (now - this.eventWindowStartedMs >= 1_000) {
      this.eventWindowStartedMs = now;
      this.eventWindowCount = 0;
    }
    this.eventWindowCount += 1;
    if (this.eventWindowCount > MAXIMUM_EVENTS_PER_SECOND) {
      throw new Error("caption worker event rate exceeded the limit");
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (this.readyTimeout) clearTimeout(this.readyTimeout);
    this.readyTimeout = null;
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.rejectPending(error);
    void terminateProcessGroup(this.child, 500).catch(() => undefined);
  }

  private rejectPending(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timeout);
    const reject = this.pending.reject;
    this.pending = null;
    reject(error);
  }
}

function minimalCaptionEnvironment(sessionRoot: string): NodeJS.ProcessEnv {
  return {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HOME: sessionRoot,
    TMPDIR: sessionRoot,
    PATH: "/usr/bin:/bin",
  };
}

async function terminateProcessGroup(
  child: ChildProcessWithoutNullStreams,
  graceMs: number,
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    if (child.exitCode === null) child.kill("SIGTERM");
    await waitForClose(child, graceMs).catch(() => undefined);
    if (child.exitCode === null) child.kill("SIGKILL");
    await waitForClose(child, 2_000).catch(() => undefined);
    return;
  }
  safeKill(-pid, "SIGTERM");
  if (await waitForProcessGroupExit(pid, graceMs)) return;
  safeKill(-pid, "SIGKILL");
  if (!(await waitForProcessGroupExit(pid, 2_000))) {
    throw new Error("caption worker process group survived termination");
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // macOS can report EPERM while a successfully signaled process group
      // contains only an exited, reparented descendant awaiting final reap.
      // The initial TERM/KILL still fails closed on EPERM in safeKill(); here
      // it means there are no remaining signalable members in our owned group.
      if (code === "ESRCH" || code === "EPERM") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  return false;
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("caption worker termination deadline exceeded")),
      timeoutMs,
    );
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
