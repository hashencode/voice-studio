import * as React from "react";
import { BrainCircuit, Settings2, ShieldCheck } from "lucide-react";

import { AppSidebar } from "@/components/app-sidebar";
import { ActivityCenter } from "@/features/activity/activity-center";
import {
  SidebarInset,
  SidebarProvider,
  SidebarGroup,
  SidebarGroupContent,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  AudioContextPane,
  AudioContextPaneHeader,
  AudioMainWorkspace,
  type AudioRouteController,
  useAudioRouteController,
} from "@/features/audios/audio-route-feature";
import {
  CaptureWorkspace,
  FloatingCapturePreferenceSetting,
} from "@/features/capture/capture-workspace";
import {
  CompanionContextPane,
  CompanionContextPaneHeader,
  CompanionMainWorkspace,
  type CompanionRouteController,
  useCompanionRouteController,
} from "@/features/companion/companion-feature";
import { ContextPaneShell } from "@/features/shell/context-pane-shell";
import type {
  ContextPaneCloseReason,
  ContextPaneSection,
  RendererShellSection,
} from "@/features/shell/context-pane-contract";
import { SHELL_SECTION_LABELS } from "@/features/shell/context-pane-contract";
import { useContextPaneShell } from "@/features/shell/use-context-pane-shell";
import {
  CapabilityUnavailable,
  LoadingShell,
  OfflineBanner,
  ProfileBlocker,
  ShellLoadError,
} from "@/features/shell/shell-surfaces";
import {
  normalizeRendererSection,
  useApplicationShell,
} from "@/features/shell/use-application-shell";
import { AiSettingsFeature } from "@/features/settings/ai-settings-feature";
import type { ApplicationSnapshot } from "@shared/contracts";

const SETTINGS_SECTIONS = [
  { value: "general", label: "通用", icon: Settings2 },
  { value: "intelligence", label: "音频智能", icon: BrainCircuit },
  { value: "privacy", label: "隐私与安全", icon: ShieldCheck },
] as const;
type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["value"];

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
  const clearTransientPaneClose = pane.clearTransientClose;
  const paneTriggerRef = React.useRef<HTMLButtonElement>(null);
  const contentTitleRef = React.useRef<HTMLHeadingElement>(null);
  const captureInvokerRef = React.useRef<HTMLElement | null>(null);
  const restoreFocusFrameRef = React.useRef<number | null>(null);
  const [recordRequest, setRecordRequest] = React.useState(0);
  const [captureDetailOpen, setCaptureDetailOpen] = React.useState(false);
  const [captureDetailSessionId, setCaptureDetailSessionId] = React.useState<
    string | null
  >(null);
  const [settingsSection, setSettingsSection] =
    React.useState<SettingsSection>("general");
  const [captureCompactHost, setCaptureCompactHost] =
    React.useState<HTMLDivElement | null>(null);
  const navigatePrimary = React.useCallback(
    (section: RendererShellSection) => {
      clearTransientPaneClose();
      captureInvokerRef.current = null;
      setCaptureDetailOpen(false);
      setCaptureDetailSessionId(null);
      navigate(section);
    },
    [clearTransientPaneClose, navigate],
  );
  const changeCaptureDetail = React.useCallback(
    (open: boolean, sessionId: string | null = null) => {
      if (restoreFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(restoreFocusFrameRef.current);
        restoreFocusFrameRef.current = null;
      }
      if (open) {
        captureInvokerRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        setCaptureDetailSessionId(sessionId);
        setCaptureDetailOpen(true);
        window.requestAnimationFrame(() => contentTitleRef.current?.focus());
        return;
      }
      setCaptureDetailOpen(false);
      setCaptureDetailSessionId(null);
      const invoker = captureInvokerRef.current;
      captureInvokerRef.current = null;
      restoreFocusFrameRef.current = window.requestAnimationFrame(() => {
        restoreFocusFrameRef.current = null;
        if (invoker?.isConnected) invoker.focus();
      });
    },
    [],
  );
  React.useEffect(
    () =>
      window.voice2text.onCaptureDetailsRequested?.(() =>
        changeCaptureDetail(true),
      ),
    [changeCaptureDetail],
  );
  React.useEffect(
    () => () => {
      if (restoreFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(restoreFocusFrameRef.current);
      }
    },
    [],
  );
  const audio = useAudioRouteController({
    api: window.voice2text,
    tasks,
    pendingJobActions,
    writable:
      snapshot?.profile.phase === "ready" &&
      snapshot.capability.processing === "available",
    active: current === "audio",
    enabled: snapshot?.profile.phase === "ready",
    onRecord: () => {
      captureInvokerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setRecordRequest((value) => value + 1);
    },
    onImport: importAudio,
    onCancel: cancelProcessing,
    onRetry: retryProcessing,
  });
  const companion = useCompanionRouteController({
    api: window.voice2text,
    enabled: snapshot !== null && current === "companion",
  });
  const persistPaneClose = pane.requestClose;
  const requestPaneClose = React.useCallback(
    (reason: ContextPaneCloseReason) => {
      persistPaneClose(reason);
      paneTriggerRef.current?.focus();
    },
    [persistPaneClose],
  );

  if (loadError) return <ShellLoadError message={loadError} />;
  if (!snapshot) return <LoadingShell />;

  return (
    <SidebarProvider
      open={pane.open && pane.presentation === "docked"}
      persistState={false}
      enableKeyboardShortcut={false}
      className="h-svh overflow-hidden"
      style={{ "--sidebar-width": "350px" } as React.CSSProperties}
    >
      <AppSidebar
        current={current}
        onNavigate={navigatePrimary}
        presentation={pane.open ? pane.presentation : "closed"}
      >
        {pane.open ? (
          <ContextPaneShell
            section={pane.paneSection}
            presentation={pane.presentation}
            onRequestClose={requestPaneClose}
            header={
              pane.paneSection === "audio" ? (
                <AudioContextPaneHeader controller={audio} />
              ) : pane.paneSection === "companion" ? (
                <CompanionContextPaneHeader controller={companion} />
              ) : null
            }
          >
            {pane.paneSection === "audio" ? (
              <AudioContextPane controller={audio} />
            ) : pane.paneSection === "companion" ? (
              <CompanionContextPane controller={companion} />
            ) : (
              <SettingsContextPane
                value={settingsSection}
                onValueChange={setSettingsSection}
                onSelected={() => {
                  if (pane.presentation === "overlay") {
                    requestPaneClose("selection");
                  }
                }}
              />
            )}
          </ContextPaneShell>
        ) : null}
      </AppSidebar>
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <header className="sticky top-0 z-10 flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b bg-background px-4 py-2">
          <ContextPaneTrigger
            ref={paneTriggerRef}
            section={pane.paneSection}
            open={pane.open}
            onToggle={pane.toggle}
          />
          <h1
            ref={contentTitleRef}
            tabIndex={-1}
            className="truncate text-sm font-medium"
            data-slot="content-title"
          >
            {captureDetailOpen
              ? "录制详情"
              : contentTitle(current, audio, companion, settingsSection)}
          </h1>
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            <div
              ref={setCaptureCompactHost}
              className="flex min-w-0 items-center"
            />
            <ActivityCenter
              items={snapshot.activity ?? []}
              onAcknowledgeThrough={(id) => {
                void window.voice2text.acknowledgeActivity?.(id);
              }}
              onOpenDetails={(item) => {
                void window.voice2text.acknowledgeActivity?.(item.id);
                changeCaptureDetail(true, item.captureSessionId);
              }}
            />
          </div>
        </header>
        {snapshot.connectivity === "offline" ? <OfflineBanner /> : null}
        <div
          id="main-content"
          data-context-pane-background="true"
          className="min-h-0 flex-1 overflow-auto p-4 sm:p-6"
          onPointerDown={(event) => {
            if (
              pane.presentation === "overlay" &&
              pane.open &&
              event.target === event.currentTarget
            ) {
              requestPaneClose("background");
            }
          }}
        >
          {!captureDetailOpen ? (
            <ShellContent
              snapshot={snapshot}
              onBootstrapAction={requestBootstrapAction}
              operationError={operationError}
              audio={audio}
              companion={companion}
              onOpenAudioPane={pane.openPane}
              onOpenCompanionPane={pane.openPane}
              settingsSection={settingsSection}
            />
          ) : null}
          <CaptureWorkspace
            capture={snapshot.capture}
            recordRequest={recordRequest}
            detailOpen={captureDetailOpen}
            focusSessionId={captureDetailSessionId}
            compactHost={captureCompactHost}
            onDetailOpenChange={changeCaptureDetail}
            onAttentionDetailsOpened={(sessionId) => {
              const activity = snapshot.activity?.find(
                (item) => !item.read && item.captureSessionId === sessionId,
              );
              if (activity) {
                void window.voice2text.acknowledgeActivity?.(activity.id);
              }
            }}
          />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function ShellContent({
  snapshot,
  onBootstrapAction,
  operationError,
  audio,
  companion,
  onOpenAudioPane,
  onOpenCompanionPane,
  settingsSection,
}: {
  snapshot: ApplicationSnapshot;
  onBootstrapAction: Parameters<typeof ProfileBlocker>[0]["onAction"];
  operationError: string | null;
  audio: AudioRouteController;
  companion: CompanionRouteController;
  onOpenAudioPane: () => void;
  onOpenCompanionPane: () => void;
  settingsSection: SettingsSection;
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
      section = (
        <CompanionMainWorkspace
          controller={companion}
          onOpenPane={onOpenCompanionPane}
        />
      );
      break;
    case "settings":
      section = <SettingsContent section={settingsSection} />;
      break;
  }
  return <div className="space-y-4">{section}</div>;
}

function SettingsContextPane({
  value,
  onValueChange,
  onSelected,
}: {
  value: SettingsSection;
  onValueChange: (value: SettingsSection) => void;
  onSelected: () => void;
}) {
  return (
    <SidebarGroup className="p-2">
      <SidebarGroupContent>
        <nav aria-label="设置分类">
          <ul className="space-y-1">
            {SETTINGS_SECTIONS.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.value}>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-current={value === item.value ? "page" : undefined}
                    className="w-full justify-start aria-current:bg-sidebar-accent"
                    onClick={() => {
                      onValueChange(item.value);
                      onSelected();
                    }}
                  >
                    <Icon aria-hidden="true" />
                    {item.label}
                  </Button>
                </li>
              );
            })}
          </ul>
        </nav>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function SettingsContent({ section }: { section: SettingsSection }) {
  if (section === "general") {
    return <FloatingCapturePreferenceSetting className="border-y py-4" />;
  }
  return (
    <AiSettingsFeature view={section === "privacy" ? "privacy" : "provider"} />
  );
}

const ContextPaneTrigger = React.forwardRef<
  HTMLButtonElement,
  {
    section: ContextPaneSection;
    open: boolean;
    onToggle: () => void;
  }
>(function ContextPaneTrigger({ section, open, onToggle }, ref) {
  const sectionLabel = SHELL_SECTION_LABELS[section];
  const label = `${open ? "收起" : "打开"}${sectionLabel}上下文面板`;
  return (
    <SidebarTrigger
      ref={ref}
      type="button"
      aria-label={label}
      aria-expanded={open}
      onClick={onToggle}
      toggleSidebarOnClick={false}
      className="-ml-1 shrink-0"
    />
  );
});

function contentTitle(
  section: RendererShellSection,
  audio: AudioRouteController,
  companion: CompanionRouteController,
  settingsSection: SettingsSection,
): string {
  if (section === "audio") {
    return audio.workspace?.summary.displayName ?? "请选择音频";
  }
  if (section === "settings") {
    return SETTINGS_SECTIONS.find((item) => item.value === settingsSection)!
      .label;
  }
  if (companion.selectedPeer) return companion.selectedPeer.displayName;
  if (companion.view.kind === "history") return "传输历史";
  if (companion.view.kind === "pairing" || companion.peers.length === 0) {
    return "配对手机";
  }
  return "请选择设备";
}
