import * as React from "react";

import type {
  ApplicationSnapshot,
  BootstrapAction,
  ShellSection,
} from "@shared/contracts";
import { useProcessingTasks } from "@/features/processing/use-processing-tasks";
import type { PersistedShellSection } from "@/features/shell/context-pane-contract";
import { useModalCoordinator } from "@/components/ui/modal-coordinator";

export function useApplicationShell() {
  const { modalOpen } = useModalCoordinator();
  const modalOpenRef = React.useRef(modalOpen);
  React.useLayoutEffect(() => {
    modalOpenRef.current = modalOpen;
  }, [modalOpen]);
  const [snapshot, setSnapshot] = React.useState<ApplicationSnapshot | null>(
    null,
  );
  const snapshotRef = React.useRef<ApplicationSnapshot | null>(null);
  const [profileBlocker, setProfileBlocker] = React.useState<{
    profile: Extract<ApplicationSnapshot["profile"], { phase: "blocked" }>;
    revision: number;
  } | null>(null);
  const profileBlockerRef = React.useRef(profileBlocker);
  const [bootstrapPending, setBootstrapPending] = React.useState(false);
  const [bootstrapError, setBootstrapError] = React.useState<string | null>(
    null,
  );
  const bootstrapRequestRef = React.useRef<Promise<void> | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const deepLinkApplied = React.useRef(false);
  const lastObservedNavigationSection = React.useRef<ShellSection | null>(null);

  const accept = React.useCallback((next: ApplicationSnapshot) => {
    const current = snapshotRef.current;
    if (current && next.revision <= current.revision) return false;

    const retainedBlocker = profileBlockerRef.current;
    const wasApplicationBlocked = retainedBlocker !== null;
    if (next.profile.phase === "blocked") {
      const blocker = { profile: next.profile, revision: next.revision };
      profileBlockerRef.current = blocker;
      setProfileBlocker(blocker);
    } else if (
      retainedBlocker &&
      next.profile.phase === "ready" &&
      next.revision > retainedBlocker.revision
    ) {
      profileBlockerRef.current = null;
      setProfileBlocker(null);
      setBootstrapError(null);
    }

    const navigationChanged =
      lastObservedNavigationSection.current !== next.navigation.section;
    lastObservedNavigationSection.current = next.navigation.section;
    const accepted =
      current &&
      (modalOpenRef.current || wasApplicationBlocked || !navigationChanged)
        ? { ...next, navigation: current.navigation }
        : next;
    snapshotRef.current = accepted;
    setSnapshot(accepted);
    setLoadError(null);
    return true;
  }, []);
  const processing = useProcessingTasks(
    accept,
    snapshot?.profile.phase === "ready",
  );

  const acceptLoadedSnapshot = React.useCallback(
    async (restored: ApplicationSnapshot) => {
      if (!accept(restored)) return;
      const deepLink = parseShellDeepLink(window.location.hash);
      if (isLegacyAudioDeepLink(window.location.hash)) {
        window.history.replaceState(null, "", "#/audio");
      }
      const restoredSection = normalizeRendererSection(
        restored.navigation.section,
      );
      if (restored.profile.phase !== "ready") {
        deepLinkApplied.current = true;
        window.history.replaceState(null, "", `#/${restoredSection}`);
        return;
      }
      if (
        ((deepLink && deepLink !== restoredSection) ||
          restored.navigation.section === "tasks") &&
        !deepLinkApplied.current
      ) {
        deepLinkApplied.current = true;
        const destination = deepLink ?? restoredSection;
        try {
          accept(
            await window.voice2text.navigate(toApplicationSection(destination)),
          );
        } catch {
          // The accepted snapshot can render even when optional deep-link navigation fails.
        }
      }
    },
    [accept],
  );

  React.useEffect(() => {
    let active = true;
    const unsubscribe = window.voice2text.onApplicationSnapshot((next) => {
      if (active) accept(next);
    });
    void window.voice2text
      .getApplicationSnapshot()
      .then(async (restored) => {
        if (!active) return;
        await acceptLoadedSnapshot(restored);
      })
      .catch(() => {
        if (active && snapshotRef.current === null) {
          setLoadError("请重新打开应用。");
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [accept, acceptLoadedSnapshot]);

  const navigateAuthorized = React.useCallback(
    async (section: PersistedShellSection) => {
      if (
        profileBlockerRef.current ||
        snapshotRef.current?.profile.phase !== "ready"
      )
        return;
      const applicationSection = toApplicationSection(section);
      if (
        snapshot &&
        normalizeRendererSection(snapshot.navigation.section) === section &&
        snapshot.navigation.section !== "tasks"
      )
        return;
      window.history.replaceState(null, "", `#/${section}`);
      accept(await window.voice2text.navigate(applicationSection));
    },
    [accept, snapshot],
  );
  const navigate = React.useCallback(
    async (section: PersistedShellSection) => {
      if (modalOpen || profileBlockerRef.current) return;
      await navigateAuthorized(section);
    },
    [modalOpen, navigateAuthorized],
  );

  const runBootstrapAction = React.useCallback(
    async (action: BootstrapAction, surface: "load" | "profile") => {
      if (bootstrapRequestRef.current) {
        await bootstrapRequestRef.current;
        return;
      }
      if (surface === "profile") setBootstrapError(null);
      setBootstrapPending(true);
      const startingRevision = snapshotRef.current?.revision ?? null;
      const request = (async () => {
        try {
          const restored =
            await window.voice2text.requestBootstrapAction(action);
          if (surface === "load") {
            await acceptLoadedSnapshot(restored);
          } else {
            accept(restored);
          }
        } catch {
          if ((snapshotRef.current?.revision ?? null) !== startingRevision) {
            return;
          }
          if (surface === "load") {
            setLoadError("无法重新载入，请重试。");
          } else {
            setBootstrapError("无法重新检查，请重试。");
          }
        } finally {
          setBootstrapPending(false);
          bootstrapRequestRef.current = null;
        }
      })();
      bootstrapRequestRef.current = request;
      await request;
    },
    [accept, acceptLoadedSnapshot],
  );
  const requestBootstrapAction = React.useCallback(
    async (action: BootstrapAction) => {
      await runBootstrapAction(action, "profile");
    },
    [runBootstrapAction],
  );
  const reloadApplication = React.useCallback(async () => {
    await runBootstrapAction("recheck", "load");
  }, [runBootstrapAction]);

  return {
    snapshot,
    profileBlocker,
    bootstrapPending,
    bootstrapError,
    loadError,
    ...processing,
    navigate,
    navigateAuthorized,
    reloadApplication,
    requestBootstrapAction,
  };
}

export function parseShellDeepLink(hash: string): PersistedShellSection | null {
  const value = hash.replace(/^#\/?/, "").split("/")[0];
  if (value === "audio" || value === "library" || value === "tasks") {
    return "audio";
  }
  return value === "companion" || value === "settings" ? value : null;
}

function isLegacyAudioDeepLink(hash: string): boolean {
  const value = hash.replace(/^#\/?/, "").split("/")[0];
  return value === "library" || value === "tasks";
}

export function normalizeRendererSection(
  section: ShellSection,
): PersistedShellSection {
  return section === "library" || section === "tasks" ? "audio" : section;
}

function toApplicationSection(section: PersistedShellSection): ShellSection {
  return section === "audio" ? "library" : section;
}
