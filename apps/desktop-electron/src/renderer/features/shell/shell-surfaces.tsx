import {
  AlertTriangle,
  CloudOff,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Wrench,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ApplicationSnapshot, BootstrapAction } from "@shared/contracts";

export function LoadingShell() {
  return (
    <main className="grid min-h-svh place-items-center p-6">
      <div role="status" aria-label="正在加载工作台" className="text-center">
        <LoaderCircle
          className="mx-auto size-6 animate-spin"
          aria-hidden="true"
        />
        <p className="mt-3 text-sm text-muted-foreground">正在加载工作台</p>
      </div>
    </main>
  );
}

export function ShellLoadError({ message }: { message: string }) {
  return (
    <main className="grid min-h-svh place-items-center p-6">
      <section
        role="alert"
        className="max-w-lg rounded-xl border bg-card p-6 text-center"
      >
        <AlertTriangle
          className="mx-auto size-7 text-destructive"
          aria-hidden="true"
        />
        <h1 className="mt-3 text-xl font-semibold">无法载入工作台</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      </section>
    </main>
  );
}

export function ProfileBlocker({
  profile,
  onAction,
}: {
  profile: Extract<ApplicationSnapshot["profile"], { phase: "blocked" }>;
  onAction: (action: BootstrapAction) => void;
}) {
  return (
    <section
      role="alert"
      className="mx-auto max-w-2xl rounded-xl border bg-card p-6 shadow-sm"
    >
      <ShieldAlert className="size-8 text-destructive" aria-hidden="true" />
      <h1 className="mt-4 text-xl font-semibold">本机资料库需要修复</h1>
      <p className="mt-2 text-sm text-muted-foreground">{profile.message}</p>
      <p className="mt-3 text-sm">修复前，导入和创建会议等写入操作保持禁用。</p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button onClick={() => onAction("retry")}>
          <RefreshCw aria-hidden="true" />
          重试初始化
        </Button>
        <Button variant="outline" onClick={() => onAction("repair-guidance")}>
          <Wrench aria-hidden="true" />
          查看修复建议
        </Button>
        <Button variant="secondary" disabled aria-disabled="true">
          导入会议
        </Button>
      </div>
    </section>
  );
}

export function OfflineBanner() {
  return (
    <div
      role="status"
      aria-label="离线状态"
      className="flex items-center gap-2 border-b bg-muted px-4 py-2 text-sm"
    >
      <CloudOff className="size-4" aria-hidden="true" />
      离线 · 本机资料仍可浏览，需要网络的功能暂不可用
    </div>
  );
}

export function ReconciliationSurface({
  items,
}: {
  items: ApplicationSnapshot["reconciliation"];
}) {
  return (
    <section role="alert" className="rounded-xl border bg-card p-6 shadow-sm">
      <h1 className="text-xl font-semibold">启动恢复需要确认</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        检测到 {items.length}{" "}
        个中断或可恢复项目。工作台不会自动重试，也不会宣称完成。
      </p>
      <ul className="mt-4 space-y-2">
        {items.map((item) => (
          <li
            key={`${item.kind}:${item.identity}`}
            className="rounded-lg bg-muted px-3 py-2 text-sm"
          >
            {reconciliationLabel(item.kind)} · {item.identity} ·{" "}
            {item.state === "repairable" ? "可恢复" : "已中断"}
          </li>
        ))}
      </ul>
      <div className="mt-4 flex gap-2">
        <Button>逐项检查</Button>
        <Button variant="outline">稍后处理</Button>
      </div>
    </section>
  );
}

export function LibrarySurface({
  state,
  writable,
}: {
  state: ApplicationSnapshot["library"];
  writable: boolean;
}) {
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            仅存储在这台设备
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">本机会议</h1>
        </div>
        <div className="flex gap-2">
          <Button disabled={!writable}>开始会议</Button>
          <Button variant="outline" disabled={!writable}>
            导入会议
          </Button>
        </div>
      </div>
      {state.phase === "loading" ? (
        <StateCard
          icon={LoaderCircle}
          title="正在加载会议库"
          description="正在读取 Electron 独立资料库。"
          busy
        />
      ) : state.phase === "error" ? (
        <StateCard
          icon={AlertTriangle}
          title="会议库暂时不可用"
          description={state.message}
          alert
        />
      ) : state.phase === "empty" ? (
        <StateCard
          icon={FolderOpen}
          title="还没有本机会议"
          description="开始电脑会议，或安全导入已有音频和视频。"
        />
      ) : (
        <StateCard
          icon={FolderOpen}
          title={`${state.meetingCount} 个本机会议`}
          description="会议详情将在后续迁移单元接入。"
        />
      )}
    </section>
  );
}

export function CapabilityUnavailable({ reason }: { reason: string }) {
  return (
    <section role="alert" className="rounded-xl border bg-card p-6">
      <AlertTriangle className="size-7 text-destructive" aria-hidden="true" />
      <h2 className="mt-3 text-lg font-semibold">本地处理不可用</h2>
      <p className="mt-2 text-sm text-muted-foreground">{reason}</p>
      <p className="mt-3 text-sm">
        会议资料不会因此丢失；可在设置中修复运行时后重试。
      </p>
    </section>
  );
}

function StateCard({
  icon: Icon,
  title,
  description,
  busy = false,
  alert = false,
}: {
  icon: typeof FolderOpen;
  title: string;
  description: string;
  busy?: boolean;
  alert?: boolean;
}) {
  return (
    <div
      role={alert ? "alert" : busy ? "status" : undefined}
      className="grid min-h-64 place-items-center rounded-xl border bg-card p-8 text-center"
    >
      <div>
        <Icon
          className={`mx-auto size-8 ${busy ? "animate-spin" : ""}`}
          aria-hidden="true"
        />
        <h2 className="mt-4 text-lg font-semibold">{title}</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}

function reconciliationLabel(
  kind: ApplicationSnapshot["reconciliation"][number]["kind"],
): string {
  return {
    processing: "处理任务",
    capture: "录制",
    staging: "导入",
    ai: "AI 任务",
    transfer: "传输",
  }[kind];
}
