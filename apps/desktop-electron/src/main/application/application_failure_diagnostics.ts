import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  activityItemSchema,
  applicationActivityLimit,
  type ActivityDiagnostic,
  type ActivityItem,
} from "../../shared/contracts";

const maximumLogBytes = 256 * 1024;

const knownReasons: Record<string, string> = {
  EACCES: "无法访问所需资源。",
  EBUSY: "所需资源正在被占用。",
  ECONNREFUSED: "无法连接到所需服务。",
  ENOENT: "未找到所需资源。",
  ENOSPC: "可用磁盘空间不足。",
  ETIMEDOUT: "等待所需组件响应超时。",
};
const knownMessages = [
  {
    pattern:
      /resource artifact hash mismatch|resource command artifact hash mismatch/,
    code: "RESOURCE_HASH_MISMATCH",
    reason: "内置处理资源校验未通过。",
  },
  {
    pattern: /(?:model|processing) identity artifact is absent/,
    code: "MODEL_RESOURCE_MISSING",
    reason: "所需模型资源不存在。",
  },
  {
    pattern: /resource catalog is missing manifest inventory/,
    code: "RESOURCE_INVENTORY_INCOMPLETE",
    reason: "内置处理资源不完整。",
  },
] as const;

export function createApplicationFailureDiagnostic(options: {
  error?: unknown;
  stage: string;
  fallbackCode: string;
  appVersion: string;
  reason?: string;
}): ActivityDiagnostic {
  const error = options.error;
  const rawCode =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  const classified =
    error instanceof Error
      ? knownMessages.find((entry) => entry.pattern.test(error.message))
      : undefined;
  const code =
    typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
      ? rawCode
      : (classified?.code ?? options.fallbackCode);
  const exceptionType =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
      ? error.name.slice(0, 80)
      : null;
  const stackFrames =
    error instanceof Error
      ? (error.stack ?? "")
          .split("\n")
          .slice(1)
          .map((line) => /^\s*at ([^(/]+)\s*\(/.exec(line)?.[1]?.trim())
          .filter((frame): frame is string =>
            Boolean(frame && /^[A-Za-z0-9_.$<> ]{1,160}$/.test(frame)),
          )
          .slice(0, 8)
      : [];
  return {
    eventId: randomUUID(),
    stage: options.stage,
    code,
    reason:
      options.reason ??
      knownReasons[code] ??
      classified?.reason ??
      "具体原因尚未分类，可使用事件编号和技术信息排查。",
    exceptionType,
    stackFrames,
    appVersion: options.appVersion,
    occurredAt: Date.now(),
  };
}

export function appendApplicationFailureLog(
  userDataRoot: string,
  item: Pick<ActivityItem, "kind" | "safeSummary" | "settingsTarget"> & {
    diagnostic: ActivityDiagnostic;
  },
): void {
  const directory = join(userDataRoot, "diagnostics");
  const file = join(directory, "application-failures.jsonl");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    if (statSync(file).size >= maximumLogBytes) {
      renameSync(file, `${file}.1`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  appendFileSync(file, `${JSON.stringify(item)}\n`, { mode: 0o600 });
}

export function readApplicationActivity(userDataRoot: string): ActivityItem[] {
  try {
    const file = join(userDataRoot, "diagnostics", "activity.json");
    return activityItemSchema
      .array()
      .max(applicationActivityLimit)
      .parse(JSON.parse(readFileSync(file, "utf8")))
      .filter((item) => !item.sample);
  } catch {
    return [];
  }
}

export function writeApplicationActivity(
  userDataRoot: string,
  activity: readonly ActivityItem[],
): void {
  const directory = join(userDataRoot, "diagnostics");
  const file = join(directory, "activity.json");
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(
      temporaryFile,
      JSON.stringify(activity.filter((item) => !item.sample)),
      { mode: 0o600 },
    );
    renameSync(temporaryFile, file);
  } finally {
    rmSync(temporaryFile, { force: true });
  }
}
