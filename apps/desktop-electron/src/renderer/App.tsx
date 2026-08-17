import * as React from "react";

import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { CaptureWorkspace } from "@/features/capture/capture-workspace";
import { CompanionFeature } from "@/features/companion/companion-feature";
import {
  CapabilityUnavailable,
  LoadingShell,
  OfflineBanner,
  ProfileBlocker,
  ReconciliationSurface,
  ShellLoadError,
} from "@/features/shell/shell-surfaces";
import { useApplicationShell } from "@/features/shell/use-application-shell";
import { LibraryFeature } from "@/features/library/library-feature";
import { AudioWorkspaceFeature } from "@/features/audios/audio-workspace-feature";
import { AiSettingsFeature } from "@/features/settings/ai-settings-feature";
import { TasksFeature } from "@/features/tasks/tasks-feature";
import type { ApplicationSnapshot } from "@shared/contracts";

const SIDEBAR_STORAGE_KEY = "voice2text.shell.sidebar-open.v1";

export default function App() {
  const {
    snapshot,
    loadError,
    operationError,
    importPending,
    tasks,
    pendingJobActions,
    navigate,
    requestBootstrapAction,
    importAudio,
    cancelProcessing,
    retryProcessing,
  } = useApplicationShell();
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
            onNavigate={navigate}
            onBootstrapAction={requestBootstrapAction}
            operationError={operationError}
            importPending={importPending}
            tasks={tasks}
            pendingJobActions={pendingJobActions}
            onImport={importAudio}
            onCancel={cancelProcessing}
            onRetry={retryProcessing}
          />
        </main>
      </SidebarInset>
      <CaptureWorkspace
        capture={snapshot.capture}
        applicationRevision={snapshot.revision}
      />
    </SidebarProvider>
  );
}

function ShellContent({
  snapshot,
  onNavigate,
  onBootstrapAction,
  operationError,
  importPending,
  tasks,
  pendingJobActions,
  onImport,
  onCancel,
  onRetry,
}: {
  snapshot: ApplicationSnapshot;
  onNavigate: (section: ApplicationSnapshot["navigation"]["section"]) => void;
  onBootstrapAction: Parameters<typeof ProfileBlocker>[0]["onAction"];
  operationError: string | null;
  importPending: boolean;
  tasks: Parameters<typeof TasksFeature>[0]["tasks"];
  pendingJobActions: Parameters<typeof TasksFeature>[0]["pendingJobActions"];
  onImport: () => void;
  onCancel: Parameters<typeof TasksFeature>[0]["onCancel"];
  onRetry: Parameters<typeof TasksFeature>[0]["onRetry"];
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
  const navigateToTasks = () => onNavigate("tasks");
  const recovery =
    snapshot.reconciliation.length > 0 ? (
      <ReconciliationSurface
        items={snapshot.reconciliation}
        onNavigateTasks={() => void navigateToTasks()}
      />
    ) : null;

  let section: React.ReactNode;
  switch (snapshot.navigation.section) {
    case "library":
      section = (
        <div className="space-y-4">
          {operationError ? <OperationError message={operationError} /> : null}
          {snapshot.capability.processing === "unavailable" ? (
            <CapabilityUnavailable reason={snapshot.capability.reason} />
          ) : null}
          <LibraryFeature
            state={snapshot.library}
            writable={snapshot.capability.processing === "available"}
            importPending={importPending}
            onImport={onImport}
          />
          <AudioWorkspaceFeature />
        </div>
      );
      break;
    case "tasks":
      section = (
        <div className="space-y-4">
          {operationError ? <OperationError message={operationError} /> : null}
          {snapshot.capability.processing === "unavailable" ? (
            <CapabilityUnavailable reason={snapshot.capability.reason} />
          ) : null}
          <TasksFeature
            tasks={tasks}
            pendingJobActions={pendingJobActions}
            onCancel={onCancel}
            onRetry={onRetry}
          />
        </div>
      );
      break;
    case "companion":
      section = <CompanionFeature />;
      break;
    case "settings":
      section = (
        <Page title="设置" eyebrow="本机与隐私">
          <AiSettingsFeature />
        </Page>
      );
      break;
  }
  return (
    <div className="space-y-4">
      {recovery}
      {section}
    </div>
  );
}

function OperationError({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-lg border bg-card px-4 py-3 text-sm">
      操作未完成：{message}
    </div>
  );
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
