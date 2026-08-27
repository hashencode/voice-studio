import * as React from "react";
import { Cloud, HardDrive, Settings2 } from "lucide-react";

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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";
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
  CompanionContextPaneFooter,
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
import {
  SettingsListBlock,
  SettingsPageSection,
} from "@/features/settings/settings-page-section";
import {
  isSettingsSection,
  settingsSectionHeadingId,
  type SettingsSection,
} from "@/features/settings/settings-section-contract";
import type { ApplicationSnapshot } from "@shared/contracts";
import {
  ModalCoordinatorProvider,
  useModalCoordinator,
} from "@/components/ui/modal-coordinator";

const SETTINGS_SECTIONS = [
  { value: "general", label: "通用", icon: Settings2 },
  { value: "local-models", label: "本地模型", icon: HardDrive },
  { value: "cloud-models", label: "云端模型", icon: Cloud },
] as const;
const EMPTY_ACTIVITY_ITEMS: ActivityItemView[] = [];

function scrollSettingsSectionIntoView(
  section: SettingsSection,
  focus = false,
): boolean {
  const heading = document.getElementById(settingsSectionHeadingId(section));
  if (!heading) return false;
  heading.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
    block: "start",
  });
  if (focus) heading.focus({ preventScroll: true });
  return true;
}

export default function AppRoot() {
  return (
    <ModalCoordinatorProvider>
      <App />
    </ModalCoordinatorProvider>
  );
}

function App() {
  const { modalOpen, requestNavigationAfterModals } = useModalCoordinator();
  const {
    snapshot,
    profileBlocker,
    bootstrapPending,
    bootstrapError,
    loadError,
    operationError,
    tasks,
    pendingJobActions,
    navigate,
    navigateAuthorized,
    requestBootstrapAction,
    importAudio,
    cancelProcessing,
    retryProcessing,
  } = useApplicationShell();
  const applicationBlocked = profileBlocker !== null;
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
  const mainContentRef = React.useRef<HTMLDivElement>(null);
  const pendingSettingsTargetRef = React.useRef<SettingsSection | null>(null);
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
  const [activityOperationError, setActivityOperationError] = React.useState<
    string | null
  >(null);
  const [markAllActivityPending, setMarkAllActivityPending] =
    React.useState(false);
  const exactReadPendingRef = React.useRef<Set<string>>(new Set());
  const markAllReadPendingRef = React.useRef(false);
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
  const markActivityRead = React.useCallback(async (item: ActivityItemView) => {
    if (item.read || exactReadPendingRef.current.has(item.id)) return;
    exactReadPendingRef.current.add(item.id);
    setActivityOperationError(null);
    try {
      await window.voice2text.markActivityRead(item.id);
    } catch {
      setActivityOperationError("操作失败，请重试");
    } finally {
      exactReadPendingRef.current.delete(item.id);
    }
  }, []);
  const markAllActivityRead = React.useCallback(async () => {
    if (markAllReadPendingRef.current) return;
    markAllReadPendingRef.current = true;
    setMarkAllActivityPending(true);
    setActivityOperationError(null);
    try {
      await window.voice2text.markAllActivityRead();
    } catch {
      setActivityOperationError("操作失败，请重试");
    } finally {
      markAllReadPendingRef.current = false;
      setMarkAllActivityPending(false);
    }
  }, []);
  const selectedActivity =
    activityItems.find((item) => item.id === selectedActivityId) ??
    activityItems[0] ??
    null;
  const navigatePrimary = React.useCallback(
    (section: RendererShellSection) => {
      if (applicationBlocked || modalOpen) return;
      captureInvokerRef.current = null;
      setCaptureDetailOpen(false);
      setCaptureDetailSessionId(null);
      if (section === "messages") {
        setMessagesOpen(true);
        const nextSelection = selectedActivity ?? activityItems[0] ?? null;
        setSelectedActivityId(nextSelection?.id ?? null);
        if (nextSelection) void markActivityRead(nextSelection);
        return;
      }
      setMessagesOpen(false);
      navigate(section);
    },
    [
      activityItems,
      applicationBlocked,
      markActivityRead,
      modalOpen,
      navigate,
      selectedActivity,
    ],
  );
  const changeCaptureDetail = React.useCallback(
    (open: boolean, sessionId: string | null = null) => {
      if (open && applicationBlocked) return;
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
    [applicationBlocked],
  );
  const openActivityDetails = React.useCallback(
    (item: ActivityItemView) => {
      if (applicationBlocked) return;
      void markActivityRead(item);
      setActivityError(null);
      const navigateToDetails = () => {
        changeCaptureDetail(true, item.captureSessionId);
        window.requestAnimationFrame(() => contentTitleRef.current?.focus());
      };
      if (modalOpen) requestNavigationAfterModals(navigateToDetails);
      else navigateToDetails();
    },
    [
      changeCaptureDetail,
      applicationBlocked,
      markActivityRead,
      modalOpen,
      requestNavigationAfterModals,
    ],
  );
  const lastAutoReadActivityIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (current !== "messages" || !selectedActivity) {
      lastAutoReadActivityIdRef.current = null;
      return;
    }
    if (lastAutoReadActivityIdRef.current === selectedActivity.id) return;
    lastAutoReadActivityIdRef.current = selectedActivity.id;
    void markActivityRead(selectedActivity);
  }, [current, markActivityRead, selectedActivity]);
  React.useEffect(
    () =>
      window.voice2text.onCaptureDetailsRequested?.(() => {
        if (!applicationBlocked && !modalOpen) changeCaptureDetail(true);
      }),
    [applicationBlocked, changeCaptureDetail, modalOpen],
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
    if (applicationBlocked || modalOpen) return;
    paneTriggerFocusPendingRef.current = true;
    persistPaneClose();
  }, [applicationBlocked, modalOpen, persistPaneClose]);
  const requestPaneToggle = React.useCallback(() => {
    if (applicationBlocked || modalOpen) return;
    if (pane.open) paneTriggerFocusPendingRef.current = true;
    pane.toggle();
  }, [applicationBlocked, modalOpen, pane]);
  const openPane = React.useCallback(() => {
    if (!applicationBlocked && !modalOpen) pane.openPane();
  }, [applicationBlocked, modalOpen, pane]);
  const navigateSettingsSection = React.useCallback(
    (value: SettingsSection) => {
      if (applicationBlocked || modalOpen) return;
      setSettingsSection(value);
      window.requestAnimationFrame(() => {
        scrollSettingsSectionIntoView(value);
      });
    },
    [applicationBlocked, modalOpen],
  );
  const openLocalModels = React.useCallback(() => {
    if (applicationBlocked) return;
    const navigateToLocalModels = () => {
      pendingSettingsTargetRef.current = "local-models";
      setSettingsSection("local-models");
      setMessagesOpen(false);
      void navigateAuthorized("settings");
    };
    if (modalOpen) requestNavigationAfterModals(navigateToLocalModels);
    else navigateToLocalModels();
  }, [
    applicationBlocked,
    modalOpen,
    navigateAuthorized,
    requestNavigationAfterModals,
  ]);
  React.useEffect(() => {
    if (!applicationBlocked) return;
    pendingSettingsTargetRef.current = null;
    setActivityError(null);
    setProcessingUnavailableReason(null);
    setCaptureDetailOpen(false);
    setCaptureDetailSessionId(null);
  }, [applicationBlocked]);
  React.useEffect(() => {
    if (current !== "settings" || !pendingSettingsTargetRef.current) return;
    const target = pendingSettingsTargetRef.current;
    const frame = window.requestAnimationFrame(() => {
      if (!scrollSettingsSectionIntoView(target, true)) return;
      pendingSettingsTargetRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [current]);
  React.useEffect(() => {
    if (current !== "settings") return;
    const container = mainContentRef.current;
    if (!container) return;
    const sections = Array.from(
      container.querySelectorAll<HTMLElement>("[data-settings-section]"),
    ).flatMap((element) => {
      const section = element.dataset.settingsSection;
      return isSettingsSection(section) ? [{ element, section }] : [];
    });
    if (sections.length === 0) return;
    let frame: number | null = null;
    const updateActiveSection = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const marker = container.getBoundingClientRect().top + 32;
        let next = sections[0]!.section;
        for (const candidate of sections) {
          if (candidate.element.getBoundingClientRect().top > marker) break;
          next = candidate.section;
        }
        if (
          container.scrollHeight -
            container.scrollTop -
            container.clientHeight <=
          2
        ) {
          next = sections.at(-1)!.section;
        }
        setSettingsSection((currentSection) =>
          currentSection === next ? currentSection : next,
        );
      });
    };
    container.addEventListener("scroll", updateActiveSection, {
      passive: true,
    });
    return () => {
      container.removeEventListener("scroll", updateActiveSection);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [current]);
  React.useEffect(() => {
    if (pane.open || !paneTriggerFocusPendingRef.current) return;
    paneTriggerFocusPendingRef.current = false;
    paneTriggerRef.current?.focus();
  }, [pane.open]);

  if (loadError) return <ShellLoadError message={loadError} />;
  if (!snapshot) return <LoadingShell />;

  const presentation = deriveContentPresentation({
    captureDetailVisible,
    current,
    audio,
    companion,
    selectedActivity,
    activityItems,
  });
  const standalonePaneTriggerVisible = !pane.open && !presentation.title;

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
          footer={
            pane.paneSection === "audio" && audio.workspace !== null ? (
              <AudioContextPaneHeader controller={audio} />
            ) : pane.paneSection === "companion" &&
              companion.view.kind === "device" ? (
              <CompanionContextPaneFooter controller={companion} />
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
                void markActivityRead(item);
                if (item.kind === "capture_failed") {
                  setActivityError(item);
                }
              }}
              unreadCount={unreadActivityItems.length}
              markAllPending={markAllActivityPending}
              operationError={activityOperationError}
              onMarkAllRead={() => void markAllActivityRead()}
            />
          ) : (
            <SettingsContextPane
              value={settingsSection}
              onValueChange={navigateSettingsSection}
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
        {presentation.title ? (
          <header
            className={cn(
              "sticky top-0 z-10 flex h-[58px] shrink-0 items-center gap-3 bg-background px-4 py-2",
              presentation.headerDivider && "border-b",
            )}
          >
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
              {presentation.title}
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
          ref={mainContentRef}
          id="main-content"
          data-context-pane-background="true"
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-auto",
            presentation.contentMode === "padded" && "p-4 sm:p-6",
            current === "settings" && "bg-muted/20",
            current === "settings" && standalonePaneTriggerVisible && "pt-12",
          )}
        >
          {!captureDetailVisible && presentation.renderContent ? (
            <ShellContent
              snapshot={snapshot}
              operationError={operationError}
              audio={audio}
              companion={companion}
              onOpenCompanionPane={openPane}
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
              openLocalModels();
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
              openLocalModels();
            }}
          />
          {profileBlocker ? (
            <ProfileBlocker
              profile={profileBlocker.profile}
              pending={bootstrapPending}
              error={bootstrapError}
              onRecheck={requestBootstrapAction}
            />
          ) : null}
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
  operationError,
  audio,
  companion,
  onOpenCompanionPane,
  current,
  selectedActivity,
  onOpenActivityDetails,
}: {
  snapshot: ApplicationSnapshot;
  operationError: string | null;
  audio: AudioRouteController;
  companion: CompanionRouteController;
  onOpenCompanionPane: () => void;
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
  if (snapshot.profile.phase === "blocked") return null;
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
      section = <SettingsContent />;
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
          <SidebarMenu>
            {SETTINGS_SECTIONS.map((item) => {
              const Icon = item.icon;
              return (
                <SidebarMenuItem key={item.value}>
                  <SidebarMenuButton asChild isActive={value === item.value}>
                    <a
                      href={`#${settingsSectionHeadingId(item.value)}`}
                      aria-current={
                        value === item.value ? "location" : undefined
                      }
                      onClick={(event) => {
                        event.preventDefault();
                        onValueChange(item.value);
                      }}
                    >
                      <Icon aria-hidden="true" />
                      {item.label}
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </nav>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

const SettingsContent = React.memo(function SettingsContent() {
  return (
    <div data-settings-page="true" className="min-h-full bg-muted/20">
      <div className="mx-auto w-full max-w-4xl space-y-8 px-4 py-6 sm:px-6 lg:px-10">
        <SettingsPageSection section="general" title="通用">
          <SettingsListBlock>
            <FloatingCapturePreferenceSetting className="p-4" />
          </SettingsListBlock>
        </SettingsPageSection>
        <SettingsPageSection section="local-models" title="本地模型">
          <LocalModelsFeature />
        </SettingsPageSection>
        <AiSettingsFeature settingsPage />
      </div>
    </div>
  );
});

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

type ContentPresentation = {
  title: string | null;
  contentMode: "padded" | "edge-to-edge";
  headerDivider: boolean;
  renderContent: boolean;
};

function deriveContentPresentation({
  captureDetailVisible,
  current,
  audio,
  companion,
  selectedActivity,
  activityItems,
}: {
  captureDetailVisible: boolean;
  current: RendererShellSection;
  audio: AudioRouteController;
  companion: CompanionRouteController;
  selectedActivity: ActivityItemView | null;
  activityItems: ActivityItemView[];
}): ContentPresentation {
  if (captureDetailVisible) {
    return {
      title: "录制详情",
      contentMode: "padded",
      headerDivider: true,
      renderContent: true,
    };
  }
  if (current === "audio") {
    return {
      title: audio.workspace?.summary.displayName ?? null,
      contentMode: "padded",
      headerDivider: audio.workspace !== null,
      renderContent: true,
    };
  }
  if (current === "settings") {
    return {
      title: null,
      contentMode: "edge-to-edge",
      headerDivider: false,
      renderContent: true,
    };
  }
  if (current === "messages") {
    return {
      title: selectedActivity?.title ?? null,
      contentMode: "padded",
      headerDivider: selectedActivity !== null,
      renderContent: activityItems.length > 0,
    };
  }
  if (companion.view.kind === "history") {
    return {
      title: "传输历史",
      contentMode: "edge-to-edge",
      headerDivider: false,
      renderContent: true,
    };
  }
  if (companion.view.kind === "pairing") {
    return {
      title: "配对设备",
      contentMode: "padded",
      headerDivider: true,
      renderContent: true,
    };
  }
  if (companion.selectedPeer) {
    return {
      title: companion.selectedPeer.displayName,
      contentMode: "padded",
      headerDivider: true,
      renderContent: true,
    };
  }
  return {
    title: null,
    contentMode: "padded",
    headerDivider: false,
    renderContent: true,
  };
}
