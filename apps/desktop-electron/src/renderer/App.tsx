import * as React from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  AudioContextPane,
  AudioMainWorkspace,
  type AudioRouteController,
  useAudioRouteController,
} from "@/features/audios/audio-route-feature";
import { CaptureWorkspace } from "@/features/capture/capture-workspace";
import { CompanionFeature } from "@/features/companion/companion-feature";
import {
  ContextPanePlaceholder,
  ContextPaneShell,
} from "@/features/shell/context-pane-shell";
import type { RendererShellSection } from "@/features/shell/context-pane-contract";
import { useContextPaneShell } from "@/features/shell/use-context-pane-shell";
import {
  CapabilityUnavailable,
  LoadingShell,
  OfflineBanner,
  ProfileBlocker,
  ReconciliationSurface,
  ShellLoadError,
} from "@/features/shell/shell-surfaces";
import {
  normalizeRendererSection,
  useApplicationShell,
} from "@/features/shell/use-application-shell";
import { AiSettingsFeature } from "@/features/settings/ai-settings-feature";
import type { ApplicationSnapshot } from "@shared/contracts";

export default function App() {
  const {
    snapshot,
    loadError,
    operationError,
    tasks,
    pendingJobActions,
    navigate,
    requestBootstrapAction,
    importAudio,
    cancelProcessing,
    retryProcessing,
  } = useApplicationShell();
  const current = snapshot
    ? normalizeRendererSection(snapshot.navigation.section)
    : "audio";
  const pane = useContextPaneShell(current);
  const paneTriggerRef = React.useRef<HTMLButtonElement>(null);
  const [recordRequest, setRecordRequest] = React.useState(0);
  const audio = useAudioRouteController({
    api: window.voice2text,
    tasks,
    pendingJobActions,
    writable:
      snapshot?.profile.phase === "ready" &&
      snapshot.capability.processing === "available",
    active: current === "audio",
    enabled: snapshot !== null,
    applicationRevision: snapshot?.revision ?? 0,
    onRecord: () => setRecordRequest((value) => value + 1),
    onImport: importAudio,
    onCancel: cancelProcessing,
    onRetry: retryProcessing,
  });

  if (loadError) return <ShellLoadError message={loadError} />;
  if (!snapshot) return <LoadingShell />;

  return (
    <SidebarProvider>
      <AppSidebar current={current} onNavigate={navigate} />
      {pane.paneSection && pane.open ? (
        <ContextPaneShell
          section={pane.paneSection}
          presentation={pane.presentation}
          triggerRef={paneTriggerRef}
          onRequestClose={pane.requestClose}
        >
          {pane.paneSection === "audio" ? (
            <AudioContextPane controller={audio} />
          ) : (
            <ContextPanePlaceholder section={pane.paneSection} />
          )}
        </ContextPaneShell>
      ) : null}
      <SidebarInset>
        <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2">
          {pane.paneSection ? (
            <ContextPaneTrigger
              ref={paneTriggerRef}
              section={pane.paneSection}
              open={pane.open}
              onToggle={pane.toggle}
            />
          ) : null}
          <p className="truncate text-sm font-medium">
            {sectionTitle(current)}
          </p>
        </header>
        {snapshot.connectivity === "offline" ? <OfflineBanner /> : null}
        <main
          id="main-content"
          data-context-pane-background="true"
          className="flex-1 overflow-auto p-4 sm:p-6"
          onPointerDown={(event) => {
            if (
              pane.presentation === "overlay" &&
              pane.open &&
              event.target === event.currentTarget
            ) {
              pane.requestClose("background");
              paneTriggerRef.current?.focus();
            }
          }}
        >
          <ShellContent
            snapshot={snapshot}
            onNavigate={navigate}
            onBootstrapAction={requestBootstrapAction}
            operationError={operationError}
            audio={audio}
            onOpenAudioPane={pane.openPane}
          />
        </main>
      </SidebarInset>
      <CaptureWorkspace
        capture={snapshot.capture}
        applicationRevision={snapshot.revision}
        recordRequest={recordRequest}
      />
    </SidebarProvider>
  );
}

function ShellContent({
  snapshot,
  onNavigate,
  onBootstrapAction,
  operationError,
  audio,
  onOpenAudioPane,
}: {
  snapshot: ApplicationSnapshot;
  onNavigate: (section: RendererShellSection) => void;
  onBootstrapAction: Parameters<typeof ProfileBlocker>[0]["onAction"];
  operationError: string | null;
  audio: AudioRouteController;
  onOpenAudioPane: () => void;
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
  const navigateToAudio = () => onNavigate("audio");
  const recovery =
    snapshot.reconciliation.length > 0 ? (
      <ReconciliationSurface
        items={snapshot.reconciliation}
        onNavigateAudio={() => void navigateToAudio()}
      />
    ) : null;

  let section: React.ReactNode;
  switch (normalizeRendererSection(snapshot.navigation.section)) {
    case "audio":
      section = (
        <div className="space-y-4">
          {snapshot.capability.processing === "unavailable" ? (
            <CapabilityUnavailable reason={snapshot.capability.reason} />
          ) : null}
          <AudioMainWorkspace
            controller={audio}
            onOpenPane={onOpenAudioPane}
            operationError={operationError}
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

const ContextPaneTrigger = React.forwardRef<
  HTMLButtonElement,
  {
    section: "audio" | "companion";
    open: boolean;
    onToggle: () => void;
  }
>(function ContextPaneTrigger({ section, open, onToggle }, ref) {
  const sectionLabel = section === "audio" ? "音频" : "互联";
  const label = `${open ? "收起" : "打开"}${sectionLabel}上下文面板`;
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      aria-expanded={open}
      onClick={onToggle}
      className="shrink-0"
    >
      <span aria-hidden="true">{open ? "‹" : "›"}</span>
    </Button>
  );
});

function sectionTitle(section: RendererShellSection): string {
  return {
    audio: "音频",
    companion: "互联",
    settings: "设置",
  }[section];
}
