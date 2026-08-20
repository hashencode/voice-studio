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
    <section role="alert" className="mx-auto max-w-2xl border-y py-6">
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
