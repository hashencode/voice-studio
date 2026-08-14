import * as React from "react";

import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { CaptureWorkspaceOverlay } from "@/features/shell/capture-workspace-overlay";
import {
  CapabilityUnavailable,
  LibrarySurface,
  LoadingShell,
  OfflineBanner,
  ProfileBlocker,
  ReconciliationSurface,
  ShellLoadError,
} from "@/features/shell/shell-surfaces";
import { useApplicationShell } from "@/features/shell/use-application-shell";
import type { ApplicationSnapshot } from "@shared/contracts";

const SIDEBAR_STORAGE_KEY = "voice2text.shell.sidebar-open.v1";

export default function App() {
  const { snapshot, loadError, navigate, requestBootstrapAction } =
    useApplicationShell();
  const [sidebarOpen, setSidebarOpen] = React.useState(() =>
    readSidebarPreference(),
  );

  if (loadError) return <ShellLoadError message={loadError} />;
  if (!snapshot) return <LoadingShell />;

  const updateSidebar = (open: boolean) => {
    setSidebarOpen(open);
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(open));
  };

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={updateSidebar}>
      <AppSidebar current={snapshot.navigation.section} onNavigate={navigate} />
      <SidebarInset>
        <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2">
          <AccessibleSidebarTrigger />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {sectionTitle(snapshot.navigation.section)}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              Electron 独立资料库 · Flutter Desktop 仅作行为参考
            </p>
          </div>
        </header>
        {snapshot.connectivity === "offline" ? <OfflineBanner /> : null}
        <main id="main-content" className="flex-1 overflow-auto p-4 sm:p-6">
          <ShellContent
            snapshot={snapshot}
            onBootstrapAction={requestBootstrapAction}
          />
        </main>
      </SidebarInset>
      <CaptureWorkspaceOverlay capture={snapshot.capture} />
    </SidebarProvider>
  );
}

function ShellContent({
  snapshot,
  onBootstrapAction,
}: {
  snapshot: ApplicationSnapshot;
  onBootstrapAction: Parameters<typeof ProfileBlocker>[0]["onAction"];
}) {
  if (snapshot.profile.phase === "initializing") {
    return (
      <section
        role="status"
        aria-label="正在初始化本机资料库"
        className="grid min-h-96 place-items-center text-center"
      >
        <div>
          <h1 className="text-xl font-semibold">正在初始化本机资料库</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            创建 Electron 专属目录、数据库与安全边界。
          </p>
        </div>
      </section>
    );
  }
  if (snapshot.profile.phase === "reconciling") {
    return (
      <section
        role="status"
        aria-label="正在核对启动状态"
        className="grid min-h-96 place-items-center text-center"
      >
        <div>
          <h1 className="text-xl font-semibold">正在核对启动状态</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            中断任务只会标记为待确认，不会自动重试。
          </p>
        </div>
      </section>
    );
  }
  if (snapshot.profile.phase === "blocked") {
    return (
      <ProfileBlocker profile={snapshot.profile} onAction={onBootstrapAction} />
    );
  }
  if (snapshot.reconciliation.length > 0) {
    return <ReconciliationSurface items={snapshot.reconciliation} />;
  }

  switch (snapshot.navigation.section) {
    case "library":
      return <LibrarySurface state={snapshot.library} writable />;
    case "tasks":
      return (
        <section className="space-y-5">
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              长任务由应用状态持续持有
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">转写任务</h1>
          </div>
          {snapshot.capability.processing === "unavailable" ? (
            <CapabilityUnavailable reason={snapshot.capability.reason} />
          ) : (
            <Placeholder
              title="暂无转写任务"
              description="导入或录制会议后，任务进度会在这里持续显示。"
            />
          )}
        </section>
      );
    case "companion":
      return (
        <Page title="Companion" eyebrow="手机交接">
          <Placeholder
            title="尚未连接手机"
            description="配对与局域网传输将在后续迁移单元接入。"
          />
        </Page>
      );
    case "settings":
      return (
        <Page title="设置" eyebrow="本机与隐私">
          <Placeholder
            title="桌面设置"
            description="运行时、隐私、网络和可选 AI 设置将在这里提供。"
          />
        </Page>
      );
  }
}

function Page({
  title,
  eyebrow,
  children,
}: React.PropsWithChildren<{ title: string; eyebrow: string }>) {
  return (
    <section className="space-y-5">
      <div>
        <p className="text-sm font-medium text-muted-foreground">{eyebrow}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      {children}
    </section>
  );
}

function Placeholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="grid min-h-64 place-items-center rounded-xl border bg-card p-8 text-center">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}

function AccessibleSidebarTrigger() {
  const { state } = useSidebar();
  const label = state === "expanded" ? "折叠侧边栏" : "展开侧边栏";
  return (
    <SidebarTrigger aria-label={label} title={label} className="shrink-0" />
  );
}

function sectionTitle(
  section: ApplicationSnapshot["navigation"]["section"],
): string {
  return {
    library: "会议库",
    tasks: "转写任务",
    companion: "Companion",
    settings: "设置",
  }[section];
}

function readSidebarPreference(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}
