import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  appendApplicationFailureLog,
  createApplicationFailureDiagnostic,
  readApplicationActivity,
  writeApplicationActivity,
} from "../../src/main/application/application_failure_diagnostics";
import { DesktopApplicationState } from "../../src/main/application/application_state";

it("records useful error identity without storing a private message or path", () => {
  const root = mkdtempSync(join(tmpdir(), "voice2text-diagnostic-"));
  try {
    const error = Object.assign(
      new Error("private meeting title at /Users/private/recording.wav"),
      { code: "ENOENT" },
    );
    error.stack =
      "Error: private meeting title at /Users/private/recording.wav\n" +
      "    at initializeApplication (/Users/private/src/index.ts:12:3)\n" +
      "    at /Users/private/recording.wav:2:4";
    const diagnostic = createApplicationFailureDiagnostic({
      error,
      stage: "录制组件初始化",
      fallbackCode: "CAPTURE_INITIALIZATION_FAILED",
      appVersion: "0.1.0",
    });
    appendApplicationFailureLog(root, {
      kind: "capture_runtime_unavailable",
      safeSummary: "录制组件暂不可用。",
      settingsTarget: "recording",
      diagnostic,
    });

    const path = join(root, "diagnostics", "application-failures.jsonl");
    const contents = readFileSync(path, "utf8");
    const entry = JSON.parse(contents) as { diagnostic: typeof diagnostic };
    expect(entry.diagnostic).toMatchObject({
      eventId: diagnostic.eventId,
      stage: "录制组件初始化",
      code: "ENOENT",
      reason: "未找到所需资源。",
      exceptionType: "Error",
      stackFrames: ["initializeApplication"],
    });
    expect(contents).not.toContain("private meeting title");
    expect(contents).not.toContain("/Users/private");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("classifies a known resource failure without exposing its artifact path", () => {
  const diagnostic = createApplicationFailureDiagnostic({
    error: new Error(
      "resource artifact hash mismatch: /Users/private/models/secret.bin",
    ),
    stage: "本地处理组件初始化",
    fallbackCode: "PROCESSING_INITIALIZATION_FAILED",
    appVersion: "0.1.0",
  });

  expect(diagnostic).toMatchObject({
    code: "RESOURCE_HASH_MISMATCH",
    reason: "内置处理资源校验未通过。",
  });
  expect(JSON.stringify(diagnostic)).not.toContain("/Users/private");
});

it("restores messages and read state while excluding the development sample", () => {
  const root = mkdtempSync(join(tmpdir(), "voice2text-activity-"));
  try {
    const state = new DesktopApplicationState([], (activity) =>
      writeApplicationActivity(root, activity),
    );
    state.recordApplicationFailure({
      kind: "processing_runtime_unavailable",
      safeSummary: "本地处理组件暂不可用。",
      settingsTarget: "local-models",
    });
    state.recordApplicationFailure({
      kind: "capture_runtime_unavailable",
      safeSummary: "示例消息",
      settingsTarget: "recording",
      sample: true,
    });
    state.markActivityRead(state.snapshot().activity![1]!.id);

    const restored = new DesktopApplicationState(readApplicationActivity(root));
    expect(restored.snapshot().activity).toMatchObject([
      {
        kind: "processing_runtime_unavailable",
        unread: false,
        occurrenceCount: 1,
      },
    ]);
    expect(
      readFileSync(join(root, "diagnostics", "activity.json"), "utf8"),
    ).not.toContain("示例消息");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
