import {
  AlertTriangle,
  CloudOff,
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
      <p className="mt-3 text-sm">修复前，导入和创建音频等写入操作保持禁用。</p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button onClick={() => onAction("retry")}>
          <RefreshCw aria-hidden="true" />
          重试初始化
        </Button>
        <Button variant="outline" onClick={() => onAction("repair-guidance")}>
          <Wrench aria-hidden="true" />
          查看修复建议
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
  onNavigateAudio,
}: {
  items: ApplicationSnapshot["reconciliation"];
  onNavigateAudio: () => void;
}) {
  const hasProcessing = items.some((item) => item.kind === "processing");
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
      {hasProcessing ? (
        <Button className="mt-4" onClick={onNavigateAudio}>
          查看相关音频并选择重试
        </Button>
      ) : null}
      <p className="mt-4 text-sm text-muted-foreground">
        其余恢复项目会保持显式待处理状态，不会在后台自动启动。
      </p>
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
        音频资料不会因此丢失；可在设置中修复运行时后重试。
      </p>
    </section>
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
