import * as React from "react";
import {
  Cloud,
  ArrowLeft,
  ArrowRight,
  HardDrive,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
} from "lucide-react";

import { AppSidebar } from "@/components/app-sidebar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  ActivityContextPane,
  ActivityContextPaneFilters,
  ActivityContextPaneHead,
  ActivityContextPaneSearch,
  ActivityErrorDialog,
  ActivityMainWorkspace,
  type ActivityItemView,
  type ActivityFilter,
} from "@/features/activity/activity-center";
import {
  SidebarInset,
  SidebarProvider,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import {
  AudioContextPane,
  AudioContextPaneFilters,
  AudioContextPaneHeader,
  AudioContextPaneSearch,
  AudioMainHeaderActions,
  AudioMainWorkspace,
  type AudioRouteController,
  useAudioRouteController,
} from "@/features/audios/audio-route-feature";
import { CaptureWorkspace } from "@/features/capture/capture-workspace";
import {
  CompanionContextPane,
  CompanionContextPaneFooter,
  CompanionMainWorkspace,
  type CompanionRouteController,
  type CompanionView,
  useCompanionRouteController,
} from "@/features/companion/companion-feature";
import { ContextPaneShell } from "@/features/shell/context-pane-shell";
import { SectionContentProvider } from "@/features/shell/content-routes";
import {
  navigateSection,
  navigateSectionDelta,
  SectionRouterProvider,
  useSectionRouteSnapshot,
} from "@/features/shell/section-router-registry";
import type {
  ContextPaneSection,
  RendererShellSection,
} from "@/features/shell/context-pane-contract";
import {
  SHELL_GEOMETRY,
  SHELL_SECTION_LABELS,
} from "@/features/shell/context-pane-contract";
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
import { RecordingSettingsFeature } from "@/features/settings/recording-settings-feature";
import { SettingsPageSection } from "@/features/settings/settings-page-section";
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
  { value: "recording", label: "录制", icon: Mic },
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
  const activeRoute = useSectionRouteSnapshot(current);
  const routeDestination = React.useMemo(
    () => parseSectionRoute(current, activeRoute.pathname),
    [activeRoute.pathname, current],
  );
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
  const [activityQuery, setActivityQuery] = React.useState("");
  const [activityFilter, setActivityFilter] =
    React.useState<ActivityFilter>("all");
  const exactReadPendingRef = React.useRef<Set<string>>(new Set());
  const markAllReadPendingRef = React.useRef(false);
  const automaticCaptureDetailSessionId =
    snapshot?.capture && snapshot.capture.phase !== "idle"
      ? snapshot.capture.sessionId
      : null;
  const routedCaptureSessionId =
    routeDestination.kind === "audio-capture" ||
    routeDestination.kind === "message-capture"
      ? routeDestination.sessionId
      : null;
  const captureDetailVisible =
    routedCaptureSessionId !== null ||
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
  const routedActivityId =
    routeDestination.kind === "message" ||
    routeDestination.kind === "message-capture"
      ? routeDestination.activityId
      : null;
  const selectedActivity =
    activityItems.find(
      (item) => item.id === (routedActivityId ?? selectedActivityId),
    ) ??
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
        void navigateSection(
          "messages",
          `/messages/${encodeURIComponent(item.id)}/capture/${encodeURIComponent(item.captureSessionId)}`,
        );
        window.requestAnimationFrame(() => contentTitleRef.current?.focus());
      };
      if (modalOpen) requestNavigationAfterModals(navigateToDetails);
      else navigateToDetails();
    },
    [
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
  const closeUnblockedCaptureDetailForAudioSelection = React.useCallback(
    (audioId: number) => {
      if (!isNewRecordingBlocked(snapshot?.capture)) {
        setCaptureDetailOpen(false);
        setCaptureDetailSessionId(null);
        setDismissedCaptureDetailSessionId(automaticCaptureDetailSessionId);
      }
      void navigateSection("audio", `/audio/${audioId}`);
    },
    [automaticCaptureDetailSessionId, snapshot?.capture],
  );
  const audio = useAudioRouteController({
    api: window.voice2text,
    tasks,
    pendingJobActions,
    writable: snapshot?.profile.phase === "ready",
    processingAvailable: snapshot?.capability.processing === "available",
    recordingActive: isCaptureInProgress(snapshot?.capture),
    newRecordingBlocked: isNewRecordingBlocked(snapshot?.capture),
    libraryRefreshToken: snapshot
      ? [
          snapshot.library.phase,
          snapshot.library.phase === "ready" ? snapshot.library.audioCount : "",
        ].join(":")
      : undefined,
    recordingCompletionToken:
      snapshot?.capture.phase === "completed"
        ? snapshot.capture.sessionId
        : null,
    active: current === "audio",
    enabled: snapshot?.profile.phase === "ready",
    onAudioSelected: closeUnblockedCaptureDetailForAudioSelection,
    onRecord: () => {
      captureInvokerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setRecordRequest((value) => value + 1);
    },
    onImport: importAudio,
    onProcessingUnavailable: (reason) => {
      setProcessingUnavailableReason(
        processingUnavailableMessage(
          reason ??
            (snapshot?.capability.processing === "unavailable"
              ? snapshot.capability.reason
              : null),
        ),
      );
    },
    onCancel: cancelProcessing,
    onRetry: retryProcessing,
  });
  const navigateCompanionView = React.useCallback((view: CompanionView) => {
    void navigateSection("companion", companionPath(view));
  }, []);
  const companion = useCompanionRouteController({
    api: window.voice2text,
    enabled: snapshot !== null && current === "companion",
    onNavigate: navigateCompanionView,
  });
  const {
    audios: routeAudios,
    clearSelection: clearRouteAudioSelection,
    listError: routeAudioListError,
    listPending: routeAudioListPending,
    selectAudio: selectRouteAudio,
  } = audio;
  const {
    applyRouteView: applyCompanionRouteView,
    peers: companionPeers,
    snapshot: companionSnapshot,
  } = companion;
  const routeSyncGenerationRef = React.useRef(0);
  React.useEffect(() => {
    const generation = ++routeSyncGenerationRef.current;
    if (current === "audio") {
      if (
        routeDestination.kind === "audio" ||
        routeDestination.kind === "audio-capture"
      ) {
        const audioId = routeDestination.audioId;
        if (routeAudios === null) return;
        if (!routeAudios.some((item) => item.audioId === audioId)) {
          if (!routeAudioListPending && !routeAudioListError) {
            void navigateSection("audio", "/audio", { replace: true });
          }
          return;
        }
        void selectRouteAudio(audioId, { fromRoute: true }).then(() => {
          if (generation !== routeSyncGenerationRef.current) return;
          window.requestAnimationFrame(() => contentTitleRef.current?.focus());
        });
      } else if (routeDestination.kind === "audio-index") {
        void clearRouteAudioSelection();
      }
      return;
    }
    if (current === "messages") {
      if (
        routeDestination.kind === "message" ||
        routeDestination.kind === "message-capture"
      ) {
        const item = activityItems.find(
          (candidate) => candidate.id === routeDestination.activityId,
        );
        if (!item) {
          void navigateSection("messages", "/messages", { replace: true });
          return;
        }
        window.requestAnimationFrame(() => {
          if (generation !== routeSyncGenerationRef.current) return;
          setSelectedActivityId(item.id);
          void markActivityRead(item);
        });
      }
      return;
    }
    if (current === "companion") {
      const next = companionViewForRoute(routeDestination);
      if (next?.kind === "device") {
        if (!companionSnapshot) return;
        if (!companionPeers.some((peer) => peer.deviceId === next.deviceId)) {
          void navigateSection("companion", "/companion", { replace: true });
          return;
        }
      }
      if (next) applyCompanionRouteView(next);
      return;
    }
    if (current === "settings") {
      const category =
        routeDestination.kind === "settings-category"
          ? routeDestination.categoryId
          : "general";
      window.requestAnimationFrame(() => {
        if (generation !== routeSyncGenerationRef.current) return;
        setSettingsSection(category);
        scrollSettingsSectionIntoView(category);
      });
    }
  }, [
    activeRoute.locationKey,
    activityItems,
    applyCompanionRouteView,
    clearRouteAudioSelection,
    companionPeers,
    companionSnapshot,
    current,
    markActivityRead,
    routeAudioListError,
    routeAudioListPending,
    routeAudios,
    routeDestination,
    selectRouteAudio,
  ]);
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
      void navigateSection("settings", `/settings/${value}`);
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
      void navigateSection("settings", "/settings/local-models");
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
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      pendingSettingsTargetRef.current = null;
      setActivityError(null);
      setProcessingUnavailableReason(null);
      setCaptureDetailOpen(false);
      setCaptureDetailSessionId(null);
    });
    return () => {
      active = false;
    };
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
  const contentTitle = routeTitle(
    routeDestination,
    presentation.title,
    audio,
    selectedActivity,
    companion,
  );
  const paneStructurallyAvailable =
    current !== "audio" || audio.libraryPresentation === "populated";
  const effectivePaneOpen = pane.open && paneStructurallyAvailable;
  const audioWorkspacePresentation =
    current === "audio" && !captureDetailVisible;
  const audioFirstUsePresentation =
    audioWorkspacePresentation &&
    audio.libraryPresentation === "true-empty" &&
    snapshot.capture.phase === "idle";
  return (
    <SidebarProvider
      open={effectivePaneOpen}
      persistState={false}
      enableKeyboardShortcut={false}
      className="relative h-svh overflow-hidden"
      style={
        {
          "--sidebar-width": `${SHELL_GEOMETRY.expandedPrefixWidth}px`,
          "--sidebar-width-icon": `${SHELL_GEOMETRY.primaryRailWidth - 1}px`,
        } as React.CSSProperties
      }
    >
      <AppSidebar
        current={current}
        onNavigate={navigatePrimary}
        presentation={effectivePaneOpen ? pane.presentation : "closed"}
        unreadActivityCount={unreadActivityItems.length}
      >
        {paneStructurallyAvailable ? (
          <ContextPaneShell
            open={effectivePaneOpen}
            section={pane.paneSection}
            presentation={pane.presentation}
            variant={pane.paneSection === "audio" ? "audio" : "default"}
            onRequestClose={requestPaneClose}
            search={
              pane.paneSection === "audio" ? (
                <AudioContextPaneSearch controller={audio} />
              ) : pane.paneSection === "messages" ? (
                <ActivityContextPaneSearch
                  value={activityQuery}
                  onValueChange={setActivityQuery}
                />
              ) : undefined
            }
            head={
              pane.paneSection === "audio" && audio.workspace !== null ? (
                <AudioContextPaneHeader controller={audio} />
              ) : pane.paneSection === "messages" ? (
                <ActivityContextPaneHead
                  unreadCount={unreadActivityItems.length}
                  markAllPending={markAllActivityPending}
                  onMarkAllRead={() => void markAllActivityRead()}
                />
              ) : null
            }
            filters={
              pane.paneSection === "audio" ? (
                <AudioContextPaneFilters controller={audio} />
              ) : pane.paneSection === "messages" ? (
                <ActivityContextPaneFilters
                  items={activityItems}
                  value={activityFilter}
                  onValueChange={setActivityFilter}
                />
              ) : undefined
            }
            footer={
              pane.paneSection === "companion" &&
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
                  void navigateSection(
                    "messages",
                    `/messages/${encodeURIComponent(item.id)}`,
                  );
                  if (item.kind === "capture_failed") {
                    setActivityError(item);
                  }
                }}
                unreadCount={unreadActivityItems.length}
                markAllPending={markAllActivityPending}
                operationError={activityOperationError}
                onMarkAllRead={() => void markAllActivityRead()}
                query={activityQuery}
                filter={activityFilter}
              />
            ) : (
              <SettingsContextPane
                value={settingsSection}
                onValueChange={navigateSettingsSection}
              />
            )}
          </ContextPaneShell>
        ) : null}
      </AppSidebar>
      {paneStructurallyAvailable ? (
        <ContextPaneRail
          ref={paneTriggerRef}
          section={pane.paneSection}
          open={effectivePaneOpen}
          onToggle={requestPaneToggle}
        />
      ) : null}
      <SidebarInset
        className={`z-30 min-h-0 min-w-0 overflow-hidden transition-[margin] duration-200 ease-linear ${
          effectivePaneOpen
            ? "ml-[calc(var(--sidebar-width)-var(--sidebar-width-icon)-1px)]"
            : ""
        }`}
      >
        <header className="sticky top-0 z-10 flex h-[50px] shrink-0 items-center gap-1 border-b bg-background px-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label="后退"
            disabled={!activeRoute.canGoBack}
            onClick={() => void navigateSectionDelta(current, -1)}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label="前进"
            disabled={!activeRoute.canGoForward}
            onClick={() => void navigateSectionDelta(current, 1)}
          >
            <ArrowRight aria-hidden="true" />
          </Button>
          <Separator orientation="vertical" className="mx-2 h-4" />
          <h1
            ref={contentTitleRef}
            tabIndex={-1}
            className="truncate text-sm font-medium"
            data-slot="content-title"
          >
            {contentTitle}
          </h1>
          {audioWorkspacePresentation ? (
            <div className="ml-auto">
              <AudioMainHeaderActions controller={audio} />
            </div>
          ) : null}
        </header>
        {snapshot.connectivity === "offline" ? <OfflineBanner /> : null}
        <div
          ref={mainContentRef}
          id="main-content"
          data-context-pane-background="true"
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-auto",
            presentation.contentMode === "padded" &&
              (audioWorkspacePresentation
                ? !audioFirstUsePresentation && "p-4"
                : "p-4 sm:p-6"),
            current === "settings" && "bg-muted/20",
          )}
        >
          <SectionContentProvider
            content={
              <>
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
                  focusSessionId={
                    routedCaptureSessionId ?? captureDetailSessionId
                  }
                  autoOpenRecoveries={current === "audio"}
                  onPreflightResolved={audio.acceptCapturePreflight}
                  onDetailOpenChange={(open) => {
                    if (!open && routedCaptureSessionId) {
                      if (activeRoute.canGoBack) {
                        void navigateSectionDelta(current, -1);
                      } else {
                        void navigateSection(
                          current,
                          captureOwnerPath(routeDestination),
                          { replace: true },
                        );
                      }
                      return;
                    }
                    changeCaptureDetail(open);
                  }}
                  onOpenLocalModels={() => {
                    openLocalModels();
                  }}
                />
              </>
            }
          >
            <SectionRouterProvider section={current} />
          </SectionContentProvider>
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
            正在准备本机资料库。
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
            中断的任务会保留，稍后由你确认。
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

function processingUnavailableMessage(reason: string | null): string {
  return reason?.includes("安装")
    ? "请先安装本地转写模型。"
    : "请检查本地模型设置后重试。";
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
        <SettingsPageSection section="general" title="通用" />
        <SettingsPageSection section="recording" title="录制">
          <RecordingSettingsFeature />
        </SettingsPageSection>
        <SettingsPageSection section="local-models" title="本地模型">
          <LocalModelsFeature />
        </SettingsPageSection>
        <AiSettingsFeature settingsPage />
      </div>
    </div>
  );
});

const ContextPaneRail = React.forwardRef<
  HTMLButtonElement,
  {
    section: ContextPaneSection;
    open: boolean;
    onToggle: () => void;
    className?: string;
  }
>(function ContextPaneRail({ section, open, onToggle, className }, ref) {
  const sectionLabel = SHELL_SECTION_LABELS[section];
  const label = `${open ? "收起" : "打开"}${sectionLabel}上下文面板`;
  return (
    <SidebarRail
      ref={ref}
      data-context-pane-midpoint-rail="true"
      type="button"
      aria-label={label}
      title={label}
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      style={{
        left: open
          ? "var(--sidebar-width)"
          : "calc(var(--sidebar-width-icon) + 1px)",
      }}
      className={cn(
        "!top-1/2 right-auto !bottom-auto z-40 flex h-12 w-7 !translate-x-0 -translate-y-1/2 items-center justify-center rounded-md border bg-background text-muted-foreground after:hidden hover:bg-muted hover:text-foreground focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
    >
      {open ? (
        <PanelLeftClose className="size-4" aria-hidden="true" />
      ) : (
        <PanelLeftOpen className="size-4" aria-hidden="true" />
      )}
    </SidebarRail>
  );
});

type SectionRouteDestination =
  | { kind: "audio-index" }
  | { kind: "audio"; audioId: number }
  | { kind: "audio-capture"; audioId: number; sessionId: string }
  | { kind: "message-index" }
  | { kind: "message"; activityId: string }
  | {
      kind: "message-capture";
      activityId: string;
      sessionId: string;
    }
  | { kind: "companion-index" }
  | { kind: "companion-pairing" }
  | { kind: "companion-history" }
  | { kind: "companion-device"; deviceId: string }
  | { kind: "settings-index" }
  | { kind: "settings-category"; categoryId: SettingsSection };

function parseSectionRoute(
  section: RendererShellSection,
  pathname: string,
): SectionRouteDestination {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (section === "audio") {
    const audioId = Number(parts[1]);
    if (Number.isSafeInteger(audioId) && audioId > 0) {
      return parts[2] === "capture" && parts[3]
        ? { kind: "audio-capture", audioId, sessionId: parts[3] }
        : { kind: "audio", audioId };
    }
    return { kind: "audio-index" };
  }
  if (section === "messages") {
    const activityId = parts[1];
    if (activityId) {
      return parts[2] === "capture" && parts[3]
        ? { kind: "message-capture", activityId, sessionId: parts[3] }
        : { kind: "message", activityId };
    }
    return { kind: "message-index" };
  }
  if (section === "companion") {
    if (parts[1] === "pairing") return { kind: "companion-pairing" };
    if (parts[1] === "history") return { kind: "companion-history" };
    if (parts[1] === "device" && parts[2]) {
      return { kind: "companion-device", deviceId: parts[2] };
    }
    return { kind: "companion-index" };
  }
  const category = parts[1];
  return category && isSettingsSection(category)
    ? { kind: "settings-category", categoryId: category }
    : { kind: "settings-index" };
}

function companionPath(view: CompanionView): string {
  if (view.kind === "pairing") return "/companion/pairing";
  if (view.kind === "history") return "/companion/history";
  if (view.kind === "device") {
    return `/companion/device/${encodeURIComponent(view.deviceId)}`;
  }
  return "/companion";
}

function companionViewForRoute(
  route: SectionRouteDestination,
): CompanionView | null {
  if (route.kind === "companion-index") return { kind: "choose" };
  if (route.kind === "companion-pairing") return { kind: "pairing" };
  if (route.kind === "companion-history") return { kind: "history" };
  if (route.kind === "companion-device") {
    return { kind: "device", deviceId: route.deviceId };
  }
  return null;
}

function captureOwnerPath(route: SectionRouteDestination): string {
  if (route.kind === "audio-capture") return `/audio/${route.audioId}`;
  if (route.kind === "message-capture") {
    return `/messages/${encodeURIComponent(route.activityId)}`;
  }
  return route.kind.startsWith("message") ? "/messages" : "/audio";
}

function routeTitle(
  route: SectionRouteDestination,
  fallback: string | null,
  audio: AudioRouteController,
  activity: ActivityItemView | null,
  companion: CompanionRouteController,
): string {
  if (route.kind === "audio-capture" || route.kind === "message-capture") {
    return "录制详情";
  }
  if (route.kind === "audio") {
    return (
      audio.audios?.find((item) => item.audioId === route.audioId)
        ?.displayName ??
      fallback ??
      "音频"
    );
  }
  if (route.kind === "message") return activity?.title ?? "消息";
  if (route.kind === "companion-pairing") return "配对设备";
  if (route.kind === "companion-history") return "传输历史";
  if (route.kind === "companion-device") {
    return companion.selectedPeer?.displayName ?? "设备";
  }
  if (route.kind === "settings-category") {
    return (
      SETTINGS_SECTIONS.find((item) => item.value === route.categoryId)
        ?.label ?? "设置"
    );
  }
  if (route.kind === "audio-index") return fallback ?? "音频";
  if (route.kind === "message-index") return fallback ?? "消息";
  if (route.kind === "companion-index") return fallback ?? "互联";
  return "设置";
}

type ContentPresentation = {
  title: string | null;
  contentMode: "padded" | "edge-to-edge";
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
      renderContent: true,
    };
  }
  if (current === "audio") {
    const populated = audio.libraryPresentation === "populated";
    return {
      title: populated
        ? (audio.workspace?.summary.displayName ?? "请选择音频")
        : null,
      contentMode: "padded",
      renderContent: true,
    };
  }
  if (current === "settings") {
    return {
      title: null,
      contentMode: "edge-to-edge",
      renderContent: true,
    };
  }
  if (current === "messages") {
    return {
      title: selectedActivity?.title ?? null,
      contentMode: "padded",
      renderContent: activityItems.length > 0,
    };
  }
  if (companion.view.kind === "history") {
    return {
      title: "传输历史",
      contentMode: "edge-to-edge",
      renderContent: true,
    };
  }
  if (companion.view.kind === "pairing") {
    return {
      title: "配对设备",
      contentMode: "padded",
      renderContent: true,
    };
  }
  if (companion.selectedPeer) {
    return {
      title: companion.selectedPeer.displayName,
      contentMode: "padded",
      renderContent: true,
    };
  }
  return {
    title: null,
    contentMode: "padded",
    renderContent: true,
  };
}
