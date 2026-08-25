import * as React from "react";
import { BrainCircuit, HardDrive, Settings2, ShieldCheck } from "lucide-react";

import { AppSidebar } from "@/components/app-sidebar";
import {
  ActivityContextPane,
  ActivityErrorDialog,
  ActivityMainWorkspace,
  type ActivityItemView,
} from "@/features/activity/activity-center";
import {
  SidebarInset,
  SidebarProvider,
  SidebarGroup,
  SidebarGroupContent,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
  ContextPaneSection,
  RendererShellSection,
} from "@/features/shell/context-pane-contract";
import { SHELL_SECTION_LABELS } from "@/features/shell/context-pane-contract";
import { useContextPaneShell } from "@/features/shell/use-context-pane-shell";
import {
  CapabilityUnavailableDialog,
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
import { LocalModelsFeature } from "@/features/settings/local-models-feature";
import type { ApplicationSnapshot } from "@shared/contracts";

const SETTINGS_SECTIONS = [
  { value: "general", label: "通用", icon: Settings2 },
  { value: "local-models", label: "本地模型", icon: HardDrive },
  { value: "intelligence", label: "音频智能", icon: BrainCircuit },
  { value: "privacy", label: "隐私与安全", icon: ShieldCheck },
] as const;
type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["value"];
const EMPTY_ACTIVITY_ITEMS: ActivityItemView[] = [];

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
  const [messagesOpen, setMessagesOpen] = React.useState(false);
  const persistedSection = snapshot
    ? normalizeRendererSection(snapshot.navigation.section)
    : "audio";
  const current: RendererShellSection = messagesOpen
    ? "messages"
    : persistedSection;
  const pane = useContextPaneShell(current);
  const paneTriggerRef = React.useRef<HTMLButtonElement>(null);
  const paneTriggerFocusPendingRef = React.useRef(false);
  const contentTitleRef = React.useRef<HTMLHeadingElement>(null);
  const captureInvokerRef = React.useRef<HTMLElement | null>(null);
  const restoreFocusFrameRef = React.useRef<number | null>(null);
  const [recordRequest, setRecordRequest] = React.useState(0);
  const [processingUnavailableReason, setProcessingUnavailableReason] =
    React.useState<string | null>(null);
  const [preferredMicrophoneDeviceId, setPreferredMicrophoneDeviceId] =
    React.useState<string | null>(null);
  const [captureDetailOpen, setCaptureDetailOpen] = React.useState(false);
  const [captureDetailSessionId, setCaptureDetailSessionId] = React.useState<
    string | null
  >(null);
  const [dismissedCaptureDetailSessionId, setDismissedCaptureDetailSessionId] =
    React.useState<string | null>(null);
  const [settingsSection, setSettingsSection] =
    React.useState<SettingsSection>("general");
  const [selectedActivityId, setSelectedActivityId] = React.useState<
    string | null
  >(null);
  const [activityError, setActivityError] =
    React.useState<ActivityItemView | null>(null);
  const automaticCaptureDetailSessionId =
    snapshot?.capture && snapshot.capture.phase !== "idle"
      ? snapshot.capture.sessionId
      : null;
  const captureDetailVisible =
    captureDetailOpen ||
    (current === "audio" &&
      hasCaptureDetail(snapshot?.capture) &&
      automaticCaptureDetailSessionId !== dismissedCaptureDetailSessionId);
  const activityItems = snapshot?.activity ?? EMPTY_ACTIVITY_ITEMS;
  const unreadActivityItems = React.useMemo(
    () => activityItems.filter((item) => !item.read),
    [activityItems],
  );
  const selectedActivity =
    activityItems.find((item) => item.id === selectedActivityId) ??
    activityItems[0] ??
    null;
  const navigatePrimary = React.useCallback(
    (section: RendererShellSection) => {
      captureInvokerRef.current = null;
      setCaptureDetailOpen(false);
      setCaptureDetailSessionId(null);
      if (section === "messages") {
        setMessagesOpen(true);
        setSelectedActivityId(activityItems[0]?.id ?? null);
        const newestUnread = unreadActivityItems[0];
        if (newestUnread) {
          void window.voice2text.acknowledgeActivity?.(newestUnread.id);
        }
        return;
      }
      setMessagesOpen(false);
      navigate(section);
    },
    [activityItems, navigate, unreadActivityItems],
  );
  const changeCaptureDetail = React.useCallback(
    (open: boolean, sessionId: string | null = null) => {
      if (restoreFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(restoreFocusFrameRef.current);
        restoreFocusFrameRef.current = null;
      }
      if (open) {
        setDismissedCaptureDetailSessionId(null);
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
  const openActivityDetails = React.useCallback(
    (item: ActivityItemView) => {
      void window.voice2text.acknowledgeActivity?.(item.id);
      setActivityError(null);
      changeCaptureDetail(true, item.captureSessionId);
    },
    [changeCaptureDetail],
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
  const closeUnblockedCaptureDetailForAudioSelection = React.useCallback(() => {
    if (isNewRecordingBlocked(snapshot?.capture)) return;
    setCaptureDetailOpen(false);
    setCaptureDetailSessionId(null);
    setDismissedCaptureDetailSessionId(automaticCaptureDetailSessionId);
  }, [automaticCaptureDetailSessionId, snapshot?.capture]);
  const audio = useAudioRouteController({
    api: window.voice2text,
    tasks,
    pendingJobActions,
    writable: snapshot?.profile.phase === "ready",
    processingAvailable: snapshot?.capability.processing === "available",
    recordingActive: isCaptureInProgress(snapshot?.capture),
    newRecordingBlocked: isNewRecordingBlocked(snapshot?.capture),
    active: current === "audio",
    enabled: snapshot?.profile.phase === "ready",
    onAudioSelected: closeUnblockedCaptureDetailForAudioSelection,
    onRecord: (microphoneDeviceId) => {
      captureInvokerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setPreferredMicrophoneDeviceId(microphoneDeviceId ?? null);
      setRecordRequest((value) => value + 1);
    },
    onImport: importAudio,
    onProcessingUnavailable: (reason) => {
      setProcessingUnavailableReason(
        reason ??
          (snapshot?.capability.processing === "unavailable"
            ? snapshot.capability.reason
            : "本地转写模型暂不可用"),
      );
    },
    onCancel: cancelProcessing,
    onRetry: retryProcessing,
  });
  const companion = useCompanionRouteController({
    api: window.voice2text,
    enabled: snapshot !== null && current === "companion",
  });
  const persistPaneClose = pane.requestClose;
  const requestPaneClose = React.useCallback(() => {
    paneTriggerFocusPendingRef.current = true;
    persistPaneClose();
  }, [persistPaneClose]);
  const requestPaneToggle = React.useCallback(() => {
    if (pane.open) paneTriggerFocusPendingRef.current = true;
    pane.toggle();
  }, [pane]);
  React.useEffect(() => {
    if (pane.open || !paneTriggerFocusPendingRef.current) return;
    paneTriggerFocusPendingRef.current = false;
    paneTriggerRef.current?.focus();
  }, [pane.open]);

  if (loadError) return <ShellLoadError message={loadError} />;
  if (!snapshot) return <LoadingShell />;

  const contentHeaderVisible =
    captureDetailVisible || current !== "audio" || audio.workspace !== null;
  const standalonePaneTriggerVisible = !pane.open && !contentHeaderVisible;

  return (
    <SidebarProvider
      open={pane.open}
      persistState={false}
      enableKeyboardShortcut={false}
      className="h-svh overflow-hidden"
      style={{ "--sidebar-width": "350px" } as React.CSSProperties}
    >
      <AppSidebar
        current={current}
        onNavigate={navigatePrimary}
        presentation={pane.open ? pane.presentation : "closed"}
        unreadActivityCount={unreadActivityItems.length}
      >
        <ContextPaneShell
          open={pane.open}
          section={pane.paneSection}
          presentation={pane.presentation}
          onRequestClose={requestPaneClose}
          collapseControl={
            <ContextPaneTrigger
              ref={paneTriggerRef}
              section={pane.paneSection}
              open={pane.open}
              onToggle={requestPaneToggle}
              className="max-[349px]:mr-[calc(var(--sidebar-width)-100vw)]"
            />
          }
          header={
            pane.paneSection === "companion" ? (
              <CompanionContextPaneHeader controller={companion} />
            ) : null
          }
          footer={
            pane.paneSection === "audio" && audio.workspace !== null ? (
              <AudioContextPaneHeader controller={audio} />
            ) : null
          }
        >
          {pane.paneSection === "audio" ? (
            <AudioContextPane controller={audio} />
          ) : pane.paneSection === "companion" ? (
            <CompanionContextPane controller={companion} />
          ) : pane.paneSection === "messages" ? (
            <ActivityContextPane
              items={activityItems}
              selectedId={selectedActivity?.id ?? null}
              onSelect={(item) => {
                setSelectedActivityId(item.id);
                void window.voice2text.acknowledgeActivity?.(item.id);
                if (item.kind === "capture_failed") {
                  setActivityError(item);
                }
              }}
            />
          ) : (
            <SettingsContextPane
              value={settingsSection}
              onValueChange={setSettingsSection}
            />
          )}
        </ContextPaneShell>
      </AppSidebar>
      <SidebarInset
        className={`z-30 min-h-0 min-w-0 overflow-hidden transition-[margin] duration-200 ease-linear ${
          pane.open
            ? "ml-[calc(var(--sidebar-width)-var(--sidebar-width-icon))]"
            : ""
        }`}
      >
        {contentHeaderVisible ? (
          <header className="sticky top-0 z-10 flex min-h-[58px] shrink-0 items-center gap-3 border-b bg-background px-4 py-2">
            {!pane.open ? (
              <ContextPaneTrigger
                ref={paneTriggerRef}
                section={pane.paneSection}
                open={pane.open}
                onToggle={requestPaneToggle}
              />
            ) : null}
            <h1
              ref={contentTitleRef}
              tabIndex={-1}
              className="truncate text-sm font-medium"
              data-slot="content-title"
            >
              {captureDetailVisible
                ? "录制详情"
                : contentTitle(current, audio, companion, settingsSection)}
            </h1>
          </header>
        ) : null}
        {standalonePaneTriggerVisible ? (
          <ContextPaneTrigger
            ref={paneTriggerRef}
            section={pane.paneSection}
            open={pane.open}
            onToggle={requestPaneToggle}
            className="absolute top-4 left-4 z-20 ml-0"
          />
        ) : null}
        {snapshot.connectivity === "offline" ? <OfflineBanner /> : null}
        <div
          id="main-content"
          data-context-pane-background="true"
          className="flex min-h-0 flex-1 flex-col overflow-auto p-4 sm:p-6"
        >
          {!captureDetailVisible ? (
            <ShellContent
              snapshot={snapshot}
              onBootstrapAction={requestBootstrapAction}
              operationError={operationError}
              audio={audio}
              companion={companion}
              onOpenCompanionPane={pane.openPane}
              settingsSection={settingsSection}
              current={current}
              selectedActivity={selectedActivity}
              onOpenActivityDetails={openActivityDetails}
            />
          ) : null}
          <CaptureWorkspace
            capture={snapshot.capture}
            recordRequest={recordRequest}
            detailOpen={captureDetailVisible}
            focusSessionId={captureDetailSessionId}
            preferredMicrophoneDeviceId={preferredMicrophoneDeviceId}
            autoOpenRecoveries={current === "audio"}
            onPreflightResolved={audio.acceptCapturePreflight}
            onDetailOpenChange={changeCaptureDetail}
            onOpenLocalModels={() => {
              setSettingsSection("local-models");
              navigatePrimary("settings");
            }}
          />
          <ActivityErrorDialog
            item={activityError}
            open={activityError !== null}
            onOpenChange={(open) => {
              if (!open) setActivityError(null);
            }}
            onOpenDetails={openActivityDetails}
          />
          <CapabilityUnavailableDialog
            reason={processingUnavailableReason ?? ""}
            open={processingUnavailableReason !== null}
            onOpenChange={(open) => {
              if (!open) setProcessingUnavailableReason(null);
            }}
            onOpenLocalModels={() => {
              setProcessingUnavailableReason(null);
              setSettingsSection("local-models");
              navigatePrimary("settings");
            }}
          />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function isCaptureInProgress(
  capture: ApplicationSnapshot["capture"] | undefined,
): boolean {
  if (!capture || capture.phase === "idle") return false;
  if (capture.phase === "partial_capture") {
    return Boolean(capture.systemAudioHealthy || capture.microphoneHealthy);
  }
  return [
    "preflight",
    "preparing",
    "recording",
    "paused",
    "finalizing",
  ].includes(capture.phase);
}

function isNewRecordingBlocked(
  capture: ApplicationSnapshot["capture"] | undefined,
): boolean {
  if (!capture || ["idle", "completed", "failed"].includes(capture.phase)) {
    return false;
  }
  if (capture.phase === "partial_capture") {
    return Boolean(capture.systemAudioHealthy || capture.microphoneHealthy);
  }
  return true;
}

function hasCaptureDetail(
  capture: ApplicationSnapshot["capture"] | undefined,
): boolean {
  return Boolean(
    capture && capture.phase !== "idle" && capture.phase !== "completed",
  );
}

function ShellContent({
  snapshot,
  onBootstrapAction,
  operationError,
  audio,
  companion,
  onOpenCompanionPane,
  settingsSection,
  current,
  selectedActivity,
  onOpenActivityDetails,
}: {
  snapshot: ApplicationSnapshot;
  onBootstrapAction: Parameters<typeof ProfileBlocker>[0]["onAction"];
  operationError: string | null;
  audio: AudioRouteController;
  companion: CompanionRouteController;
  onOpenCompanionPane: () => void;
  settingsSection: SettingsSection;
  current: RendererShellSection;
  selectedActivity: ActivityItemView | null;
  onOpenActivityDetails: (item: ActivityItemView) => void;
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
  switch (current) {
    case "audio":
      section = (
        <div className="flex min-h-full flex-col gap-4">
          <AudioMainWorkspace
            controller={audio}
            operationError={operationError}
            showRecordingReady={snapshot.capture.phase === "idle"}
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
    case "messages":
      section = (
        <ActivityMainWorkspace
          item={selectedActivity}
          onOpenDetails={onOpenActivityDetails}
        />
      );
      break;
  }
  return <div className="flex min-h-full w-full flex-col gap-4">{section}</div>;
}

function SettingsContextPane({
  value,
  onValueChange,
}: {
  value: SettingsSection;
  onValueChange: (value: SettingsSection) => void;
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
  if (section === "local-models") return <LocalModelsFeature />;
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
    className?: string;
  }
>(function ContextPaneTrigger({ section, open, onToggle, className }, ref) {
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
      className={cn("-ml-1 shrink-0", className)}
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
  if (section === "messages") return "消息";
  if (companion.selectedPeer) return companion.selectedPeer.displayName;
  if (companion.view.kind === "history") return "传输历史";
  if (companion.view.kind === "pairing" || companion.peers.length === 0) {
    return "配对手机";
  }
  return "请选择设备";
}
