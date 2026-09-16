import * as React from "react";
import { Cloud, HardDrive, Mic, Settings2, X } from "lucide-react";
import { toast } from "sonner";

import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import {
  ActivityContextPane,
  ActivityContextPaneFilters,
  ActivityContextPaneHead,
  ActivityContextPaneSearch,
  ActivityMainWorkspace,
  type ActivityItemView,
  type ActivityFilter,
} from "@/features/activity/activity-center";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import {
  AudioContextPane,
  AudioContextPaneFooter,
  AudioContextPaneHeader,
  AudioContextPaneToolbar,
  AudioMainPlaybackFooter,
  AudioMainWorkspace,
  type AudioRouteController,
  useAudioRouteController,
} from "@/features/audios/audio-route-feature";
import { CaptureWorkspaceController } from "@/features/capture/capture-workspace";
import {
  CompanionContextPane,
  CompanionContextPaneFooter,
  CompanionMainWorkspace,
  type CompanionRouteController,
  type CompanionView,
  useCompanionRouteController,
} from "@/features/companion/companion-feature";
import { AppShellFrame } from "@/features/shell/app-shell-frame";
import { SectionContentProvider } from "@/features/shell/content-routes";
import {
  navigateSection,
  SectionRouterProvider,
  useSectionRouteSnapshot,
} from "@/features/shell/section-router-registry";
import type { RendererShellSection } from "@/features/shell/context-pane-contract";
import { useContextPaneShell } from "@/features/shell/use-context-pane-shell";
import { useContextPaneWidth } from "@/features/shell/use-context-pane-width";
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
import {
  SettingsPageSection,
  SettingsPageSelectionProvider,
} from "@/features/settings/settings-page-section";
import {
  isSettingsSection,
  type SettingsSection,
} from "@/features/settings/settings-section-contract";
import type { ApplicationSnapshot } from "@shared/contracts";
import {
  ModalCoordinatorProvider,
  useModalCoordinator,
} from "@/components/ui/modal-coordinator";
import { Toaster } from "@/components/ui/sonner";

const SETTINGS_SECTIONS = [
  { value: "general", label: "通用", icon: Settings2 },
  { value: "recording", label: "录制", icon: Mic },
  { value: "local-models", label: "本地模型", icon: HardDrive },
  { value: "cloud-models", label: "云端模型", icon: Cloud },
] as const;
const EMPTY_ACTIVITY_ITEMS: ActivityItemView[] = [];

export default function AppRoot() {
  return (
    <ModalCoordinatorProvider>
      <App />
      <Toaster />
    </ModalCoordinatorProvider>
  );
}

function App() {
  const audioLeaveRef = React.useRef<(() => Promise<boolean>) | null>(null);
  const primaryNavigationIntentRef = React.useRef(0);
  const { modalOpen, requestNavigationAfterModals } = useModalCoordinator();
  const {
    snapshot,
    profileBlocker,
    bootstrapPending,
    bootstrapError,
    loadError,
    tasks,
    pendingJobActions,
    navigate,
    navigateAuthorized,
    reloadApplication,
    requestBootstrapAction,
    importAudio,
    cancelProcessing,
    retryProcessing,
  } = useApplicationShell();
  const applicationBlocked = profileBlocker !== null;
  const navigateAuthorizedRef = React.useRef(navigateAuthorized);
  React.useEffect(() => {
    navigateAuthorizedRef.current = navigateAuthorized;
  }, [navigateAuthorized]);
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
  const initialSettingsRouteAppliedRef = React.useRef(false);
  React.useEffect(() => {
    if (current !== "settings" || initialSettingsRouteAppliedRef.current) {
      return;
    }
    initialSettingsRouteAppliedRef.current = true;
    const parts = window.location.hash
      .replace(/^#\/?/, "")
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const category = parts[1];
    if (
      parts[0] !== "settings" ||
      parts.length !== 2 ||
      !isSettingsSection(category)
    ) {
      return;
    }
    void navigateSection("settings", `/settings/${category}`, {
      replace: true,
    });
  }, [current]);
  const settingsSection: SettingsSection =
    routeDestination.kind === "settings-category"
      ? routeDestination.categoryId
      : "general";
  const pane = useContextPaneShell(current);
  const contextPaneWidth = useContextPaneWidth();
  const paneTriggerRef = React.useRef<HTMLButtonElement>(null);
  const paneTriggerFocusPendingRef = React.useRef(false);
  const contentTitleRef = React.useRef<HTMLHeadingElement>(null);
  const mainContentRef = React.useRef<HTMLDivElement>(null);
  const pendingSettingsTargetRef = React.useRef<SettingsSection | null>(null);
  const captureInvokerRef = React.useRef<HTMLElement | null>(null);
  const autoOpenFocusRequestedRef = React.useRef(false);
  const suppressNextRouteAudioFocusRef = React.useRef(false);
  const restoreFocusFrameRef = React.useRef<number | null>(null);
  const [recordRequest, setRecordRequest] = React.useState(0);
  const [captureStartPending, setCaptureStartPending] = React.useState(false);
  const recordingShellMode = isCaptureInProgress(snapshot?.capture)
    ? "recordingFocus"
    : captureStartPending
      ? "startPending"
      : "browsing";
  const shellNavigationBlocked = recordingShellMode !== "browsing";
  const [processingUnavailableReason, setProcessingUnavailableReason] =
    React.useState<string | null>(null);
  const [captureDetailOpen, setCaptureDetailOpen] = React.useState(false);
  const [captureDetailSessionId, setCaptureDetailSessionId] = React.useState<
    string | null
  >(null);
  const [dismissedCaptureDetailSessionId, setDismissedCaptureDetailSessionId] =
    React.useState<string | null>(null);
  const [selectedActivityId, setSelectedActivityId] = React.useState<
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
      hasCaptureDetail(snapshot?.capture, snapshot?.libraryProjection) &&
      automaticCaptureDetailSessionId !== dismissedCaptureDetailSessionId);
  const activityItems = snapshot?.activity ?? EMPTY_ACTIVITY_ITEMS;
  const unreadActivityCount = activityItems.reduce(
    (count, item) => count + Number(item.unread),
    0,
  );
  const markActivityRead = React.useCallback(async (item: ActivityItemView) => {
    if (!item.unread || exactReadPendingRef.current.has(item.id)) return;
    exactReadPendingRef.current.add(item.id);
    const toastId = `activity-mark-read:${item.id}`;
    try {
      await window.voice2text.markActivityRead(item.id);
      toast.dismiss(toastId);
    } catch {
      toast.error("无法标记为已读，请重试。", { id: toastId });
    } finally {
      exactReadPendingRef.current.delete(item.id);
    }
  }, []);
  const markAllActivityRead = React.useCallback(async () => {
    if (markAllReadPendingRef.current) return;
    markAllReadPendingRef.current = true;
    setMarkAllActivityPending(true);
    const toastId = "activity-mark-all-read";
    try {
      await window.voice2text.markAllActivityRead();
      toast.dismiss(toastId);
    } catch {
      toast.error("无法全部标记为已读，请重试。", { id: toastId });
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
      if (applicationBlocked || modalOpen || shellNavigationBlocked) return;
      const intent = ++primaryNavigationIntentRef.current;
      const completeNavigation = () => {
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
      };
      if (current === "audio" && section !== "audio" && audioLeaveRef.current) {
        void audioLeaveRef.current().then((canLeave) => {
          if (canLeave && intent === primaryNavigationIntentRef.current) {
            completeNavigation();
          }
        });
        return;
      }
      completeNavigation();
    },
    [
      activityItems,
      applicationBlocked,
      markActivityRead,
      modalOpen,
      navigate,
      current,
      selectedActivity,
      shellNavigationBlocked,
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
  const dismissCaptureDetail = React.useCallback(() => {
    if (shellNavigationBlocked) return;
    setDismissedCaptureDetailSessionId(automaticCaptureDetailSessionId);
    changeCaptureDetail(false);
  }, [
    automaticCaptureDetailSessionId,
    changeCaptureDetail,
    shellNavigationBlocked,
  ]);
  const returnFromRoutedCapture = React.useCallback(() => {
    if (!routedCaptureSessionId || shellNavigationBlocked) return;
    setDismissedCaptureDetailSessionId(routedCaptureSessionId);
    setCaptureDetailOpen(false);
    setCaptureDetailSessionId(null);
    void navigateSection(current, captureOwnerPath(routeDestination), {
      replace: true,
    });
  }, [
    current,
    routeDestination,
    routedCaptureSessionId,
    shellNavigationBlocked,
  ]);
  const openSettingsTarget = React.useCallback(
    (settingsTarget: SettingsSection) => {
      if (applicationBlocked) return;
      const intent = ++primaryNavigationIntentRef.current;
      const navigateToSettings = () => {
        void (async () => {
          if (current === "audio" && audioLeaveRef.current) {
            const canLeave = await audioLeaveRef.current();
            if (!canLeave || intent !== primaryNavigationIntentRef.current) {
              return;
            }
          }
          if (intent !== primaryNavigationIntentRef.current) return;
          pendingSettingsTargetRef.current = settingsTarget;
          setMessagesOpen(false);
          await navigateSection("settings", `/settings/${settingsTarget}`);
          void navigateAuthorizedRef.current("settings");
        })();
      };
      if (modalOpen) requestNavigationAfterModals(navigateToSettings);
      else navigateToSettings();
    },
    [applicationBlocked, current, modalOpen, requestNavigationAfterModals],
  );
  const openFailureSettings = React.useCallback(
    (item: ActivityItemView) => {
      if (applicationBlocked || !item.settingsTarget) return;
      void markActivityRead(item);
      openSettingsTarget(item.settingsTarget);
    },
    [applicationBlocked, markActivityRead, openSettingsTarget],
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
    (audioId: number, source: "user" | "auto") => {
      if (!isNewRecordingBlocked(snapshot?.capture)) {
        setCaptureDetailOpen(false);
        setCaptureDetailSessionId(null);
        setDismissedCaptureDetailSessionId(automaticCaptureDetailSessionId);
      }
      if (source === "auto") {
        const activeElement = document.activeElement;
        const captureRegion = document.querySelector<HTMLElement>(
          '[role="region"][aria-label="录制详情"]',
        );
        autoOpenFocusRequestedRef.current = Boolean(
          activeElement instanceof HTMLElement &&
          captureRegion?.contains(activeElement),
        );
        suppressNextRouteAudioFocusRef.current =
          !autoOpenFocusRequestedRef.current;
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
    captureStartPending,
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
    liveRegisteredAudio:
      snapshot?.libraryProjection.phase === "registered"
        ? {
            intentId: snapshot.libraryProjection.intentId,
            audioId: snapshot.libraryProjection.audioId,
          }
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
  React.useEffect(() => {
    audioLeaveRef.current = audio.prepareToLeave;
    return () => {
      if (audioLeaveRef.current === audio.prepareToLeave) {
        audioLeaveRef.current = null;
      }
    };
  }, [audio.prepareToLeave]);
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
    workspace: routeAudioWorkspace,
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
        const workspaceMatches =
          routeAudioWorkspace?.summary.audioId === audioId;
        if (routeAudios === null && !workspaceMatches) return;
        if (
          !workspaceMatches &&
          !routeAudios?.some((item) => item.audioId === audioId)
        ) {
          if (!routeAudioListPending && !routeAudioListError) {
            void navigateSection("audio", "/audio", { replace: true });
          }
          return;
        }
        void selectRouteAudio(audioId, { fromRoute: true }).then(() => {
          if (generation !== routeSyncGenerationRef.current) return;
          const suppressFocus = suppressNextRouteAudioFocusRef.current;
          const focusForAutoOpen = autoOpenFocusRequestedRef.current;
          suppressNextRouteAudioFocusRef.current = false;
          autoOpenFocusRequestedRef.current = false;
          if (suppressFocus) return;
          if (focusForAutoOpen || !workspaceMatches) {
            window.requestAnimationFrame(() =>
              contentTitleRef.current?.focus({ preventScroll: true }),
            );
          }
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
    routeAudioWorkspace,
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
      void navigateSection("settings", `/settings/${value}`);
    },
    [applicationBlocked, modalOpen],
  );
  const openLocalModels = React.useCallback(() => {
    openSettingsTarget("local-models");
  }, [openSettingsTarget]);
  React.useEffect(() => {
    if (!applicationBlocked) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      pendingSettingsTargetRef.current = null;
      setProcessingUnavailableReason(null);
      setCaptureDetailOpen(false);
      setCaptureDetailSessionId(null);
    });
    return () => {
      active = false;
    };
  }, [applicationBlocked]);
  React.useLayoutEffect(() => {
    if (current !== "settings") return;
    const container = mainContentRef.current;
    if (!container) return;
    container.scrollTop = 0;
    if (pendingSettingsTargetRef.current !== settingsSection) return;
    const heading = contentTitleRef.current;
    if (!heading) return;
    pendingSettingsTargetRef.current = null;
    heading.focus({ preventScroll: true });
  }, [activeRoute.locationKey, current, settingsSection]);
  React.useEffect(() => {
    if (pane.open || !paneTriggerFocusPendingRef.current) return;
    paneTriggerFocusPendingRef.current = false;
    paneTriggerRef.current?.focus();
  }, [pane.open]);

  if (loadError) {
    return (
      <ShellLoadError
        message={loadError}
        pending={bootstrapPending}
        onReload={reloadApplication}
      />
    );
  }
  if (!snapshot) return <LoadingShell />;

  const presentation = deriveContentPresentation({
    captureDetailVisible,
    current,
    audio,
    companion,
    selectedActivity,
  });
  const contentTitle = routeTitle(
    routeDestination,
    presentation.title,
    audio,
    selectedActivity,
    companion,
  );
  const paneStructurallyAvailable =
    !captureDetailVisible &&
    (current !== "audio" ||
      audio.libraryPresentation === "populated" ||
      audio.workspace !== null) &&
    (current !== "messages" || activityItems.length > 0);
  const audioWorkspacePresentation =
    current === "audio" && !captureDetailVisible;
  const audioDetailPresentation =
    audioWorkspacePresentation && audio.workspace !== null;
  const audioFirstUsePresentation =
    audioWorkspacePresentation &&
    audio.libraryPresentation === "true-empty" &&
    snapshot.capture.phase === "idle";
  const audioSelectionEmptyPresentation =
    audioWorkspacePresentation &&
    audio.libraryPresentation === "populated" &&
    audio.workspace === null;
  const messageEmptyPresentation =
    current === "messages" &&
    !captureDetailVisible &&
    activityItems.length === 0;
  const fullScreenEmptyPresentation =
    audioFirstUsePresentation || messageEmptyPresentation;
  const emptyPresentationHidesChrome =
    fullScreenEmptyPresentation || audioSelectionEmptyPresentation;
  let contentPadding: "none" | "compact" | "page" = "none";
  if (presentation.contentMode === "padded") {
    if (emptyPresentationHidesChrome) contentPadding = "none";
    else if (audioDetailPresentation) contentPadding = "none";
    else if (audioWorkspacePresentation) contentPadding = "compact";
    else contentPadding = "page";
  }
  const failedLibraryProjection =
    snapshot.libraryProjection.phase === "failed"
      ? snapshot.libraryProjection
      : null;
  const captureLibraryOpenState =
    snapshot.libraryProjection.phase === "registered" &&
    audio.autoOpenState.phase !== "idle" &&
    audio.autoOpenState.intentId === snapshot.libraryProjection.intentId &&
    audio.autoOpenState.audioId === snapshot.libraryProjection.audioId
      ? audio.autoOpenState
      : ({ phase: "idle" } as const);
  const backAction =
    recordingShellMode === "browsing" && routedCaptureSessionId
      ? {
          label:
            routeDestination.kind === "message-capture"
              ? "返回消息"
              : "返回音频",
          onBack: returnFromRoutedCapture,
        }
      : undefined;
  return (
    <CaptureWorkspaceController
      capture={snapshot.capture}
      libraryProjection={snapshot.libraryProjection}
      libraryOpenState={captureLibraryOpenState}
      recordRequest={recordRequest}
      detailOpen={captureDetailVisible}
      focusSessionId={routedCaptureSessionId ?? captureDetailSessionId}
      onPreflightResolved={audio.acceptCapturePreflight}
      onStartPendingChange={setCaptureStartPending}
      onRetryLibraryProjection={
        failedLibraryProjection
          ? async () => {
              await window.voice2text.retryCaptureLibraryProjection({
                sessionId: failedLibraryProjection.sessionId,
                intentId: failedLibraryProjection.intentId,
              });
            }
          : undefined
      }
      onRetryLibraryOpen={audio.retryAutoOpen}
      onDetailOpenChange={(open) => {
        if (open && current !== "audio") return;
        if (!open && shellNavigationBlocked) return;
        if (!open && routedCaptureSessionId) {
          returnFromRoutedCapture();
          return;
        }
        changeCaptureDetail(open);
      }}
    >
      {(captureWorkspace) => (
        <AppShellFrame
          section={current}
          onNavigate={navigatePrimary}
          unreadActivityCount={unreadActivityCount}
          contextPaneWidth={contextPaneWidth.effectiveWidth}
          contextPaneResize={{
            minimum: contextPaneWidth.limits.minimum,
            maximum: contextPaneWidth.limits.maximum,
            disabled: applicationBlocked || modalOpen,
            onChange: contextPaneWidth.setRequestedWidth,
          }}
          contextPane={
            paneStructurallyAvailable
              ? {
                  open: pane.open,
                  section: pane.paneSection,
                  presentation: pane.presentation,
                  onRequestClose: requestPaneClose,
                  search:
                    pane.paneSection === "audio" ? (
                      <AudioContextPaneToolbar controller={audio} />
                    ) : pane.paneSection === "messages" ? (
                      <ActivityContextPaneSearch
                        value={activityQuery}
                        onValueChange={setActivityQuery}
                      />
                    ) : undefined,
                  searchOpen:
                    pane.paneSection === "audio"
                      ? audio.searchVisible
                      : undefined,
                  head:
                    pane.paneSection === "audio" ? (
                      <AudioContextPaneHeader controller={audio} />
                    ) : pane.paneSection === "messages" ? (
                      <ActivityContextPaneHead
                        unreadCount={unreadActivityCount}
                        markAllPending={markAllActivityPending}
                        onMarkAllRead={() => void markAllActivityRead()}
                      />
                    ) : null,
                  filters:
                    pane.paneSection === "messages" ? (
                      <ActivityContextPaneFilters
                        items={activityItems}
                        value={activityFilter}
                        onValueChange={setActivityFilter}
                      />
                    ) : undefined,
                  footer:
                    pane.paneSection === "audio" &&
                    audio.libraryPresentation === "populated" ? (
                      <AudioContextPaneFooter controller={audio} />
                    ) : pane.paneSection === "companion" &&
                      companion.view.kind === "device" ? (
                      <CompanionContextPaneFooter controller={companion} />
                    ) : null,
                  children:
                    pane.paneSection === "audio" ? (
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
                        }}
                        unreadCount={unreadActivityCount}
                        markAllPending={markAllActivityPending}
                        onMarkAllRead={() => void markAllActivityRead()}
                        query={activityQuery}
                        filter={activityFilter}
                      />
                    ) : (
                      <SettingsContextPane
                        value={settingsSection}
                        onValueChange={navigateSettingsSection}
                      />
                    ),
                }
              : null
          }
          paneTriggerRef={paneTriggerRef}
          onTogglePane={requestPaneToggle}
          title={contentTitle}
          titleRef={contentTitleRef}
          customTitle={
            captureDetailVisible ? captureWorkspace.customTitle : undefined
          }
          showHeader={!emptyPresentationHidesChrome && !audioDetailPresentation}
          visibility={{
            navigation: recordingShellMode !== "recordingFocus",
          }}
          navigationDisabled={recordingShellMode === "startPending"}
          backAction={backAction}
          actions={
            captureDetailVisible &&
            !routedCaptureSessionId &&
            recordingShellMode === "browsing" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7"
                aria-label="关闭录制详情"
                onClick={dismissCaptureDetail}
              >
                <X aria-hidden="true" />
              </Button>
            ) : null
          }
          notice={
            snapshot.connectivity === "offline" ? <OfflineBanner /> : null
          }
          contentRef={mainContentRef}
          contentPadding={contentPadding}
          contentTone={current === "settings" ? "muted" : "default"}
          footer={
            captureDetailVisible ? (
              captureWorkspace.footer
            ) : audioDetailPresentation ? (
              <AudioMainPlaybackFooter controller={audio} />
            ) : null
          }
        >
          <SectionContentProvider
            content={
              <>
                {!captureDetailVisible && presentation.renderContent ? (
                  <ShellContent
                    snapshot={snapshot}
                    audio={audio}
                    companion={companion}
                    onOpenCompanionPane={openPane}
                    current={current}
                    selectedActivity={selectedActivity}
                    onOpenFailureSettings={openFailureSettings}
                    settingsSection={settingsSection}
                  />
                ) : null}
                {captureWorkspace.content}
              </>
            }
          >
            <SectionRouterProvider section={current} />
          </SectionContentProvider>
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
        </AppShellFrame>
      )}
    </CaptureWorkspaceController>
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
  projection: ApplicationSnapshot["libraryProjection"] | undefined,
): boolean {
  if (!capture || capture.phase === "idle" || capture.phase === "recovery") {
    return false;
  }
  if (capture.phase !== "completed") return true;
  return projection?.phase !== "idle";
}

function ShellContent({
  snapshot,
  audio,
  companion,
  onOpenCompanionPane,
  current,
  selectedActivity,
  onOpenFailureSettings,
  settingsSection,
}: {
  snapshot: ApplicationSnapshot;
  audio: AudioRouteController;
  companion: CompanionRouteController;
  onOpenCompanionPane: () => void;
  current: RendererShellSection;
  selectedActivity: ActivityItemView | null;
  onOpenFailureSettings: (item: ActivityItemView) => void;
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
            showRecordingReady={snapshot.capture.phase === "idle"}
            recordingSessionId={
              snapshot.capture.phase === "completed"
                ? snapshot.capture.sessionId
                : null
            }
            libraryProjection={snapshot.libraryProjection}
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
          onOpenSettingsTarget={onOpenFailureSettings}
        />
      );
      break;
  }
  return <div className="flex min-h-full w-full flex-col gap-4">{section}</div>;
}

function processingUnavailableMessage(reason: string | null): string {
  return reason ?? "请检查本地模型设置后重试。";
}

function SettingsContextPane({
  value,
  onValueChange,
}: {
  value: SettingsSection;
  onValueChange: (value: SettingsSection) => void;
}) {
  return (
    <SidebarGroup className="p-0">
      <SidebarGroupContent>
        <nav aria-label="设置分类">
          <ul data-flat-row-list="true">
            {SETTINGS_SECTIONS.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.value}>
                  <Item
                    asChild
                    variant="context"
                    size="context"
                    data-active={value === item.value}
                  >
                    <button
                      type="button"
                      data-flat-row="true"
                      aria-current={
                        value === item.value ? "location" : undefined
                      }
                      onClick={() => onValueChange(item.value)}
                    >
                      <ItemMedia variant="icon">
                        <Icon aria-hidden="true" />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{item.label}</ItemTitle>
                      </ItemContent>
                    </button>
                  </Item>
                </li>
              );
            })}
          </ul>
        </nav>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

const SettingsContent = React.memo(function SettingsContent({
  section,
}: {
  section: SettingsSection;
}) {
  return (
    <div data-settings-page="true" className="min-h-full bg-muted/20">
      <SettingsPageSelectionProvider value={section}>
        <SettingsPanels />
      </SettingsPageSelectionProvider>
    </div>
  );
});

const SettingsPanels = React.memo(function SettingsPanels() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 lg:px-10">
      <SettingsPageSection section="general" label="通用" />
      <SettingsPageSection section="recording" label="录制">
        <RecordingSettingsFeature />
      </SettingsPageSection>
      <SettingsPageSection section="local-models" label="本地模型">
        <LocalModelsFeature />
      </SettingsPageSection>
      <AiSettingsFeature settingsPage />
    </div>
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
  if (route.kind === "message") return activity?.safeSummary ?? "消息";
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
  return "通用";
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
}: {
  captureDetailVisible: boolean;
  current: RendererShellSection;
  audio: AudioRouteController;
  companion: CompanionRouteController;
  selectedActivity: ActivityItemView | null;
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
      title:
        audio.workspace?.summary.displayName ??
        (populated ? "请选择音频" : null),
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
      title: selectedActivity?.safeSummary ?? null,
      contentMode: "padded",
      renderContent: true,
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
