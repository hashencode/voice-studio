import * as React from "react";

import type {
  ApplicationSnapshot,
  BootstrapAction,
  ShellSection,
} from "@shared/contracts";
import { useProcessingTasks } from "@/features/processing/use-processing-tasks";
import type { PersistedShellSection } from "@/features/shell/context-pane-contract";

export function useApplicationShell() {
  const [snapshot, setSnapshot] = React.useState<ApplicationSnapshot | null>(
    null,
  );
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const deepLinkApplied = React.useRef(false);

  const accept = React.useCallback((next: ApplicationSnapshot) => {
    setSnapshot((current) =>
      !current || next.revision > current.revision ? next : current,
    );
  }, []);
  const processing = useProcessingTasks(
    accept,
    snapshot?.profile.phase === "ready",
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
        accept(restored);
        const deepLink = parseShellDeepLink(window.location.hash);
        if (isLegacyAudioDeepLink(window.location.hash)) {
          window.history.replaceState(null, "", "#/audio");
        }
        const restoredSection = normalizeRendererSection(
          restored.navigation.section,
        );
        if (
          ((deepLink && deepLink !== restoredSection) ||
            restored.navigation.section === "tasks") &&
          !deepLinkApplied.current
        ) {
          deepLinkApplied.current = true;
          const destination = deepLink ?? restoredSection;
          accept(
            await window.voice2text.navigate(toApplicationSection(destination)),
          );
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(
            error instanceof Error ? error.message : "无法载入工作台状态",
          );
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [accept]);

  const navigate = React.useCallback(
    async (section: PersistedShellSection) => {
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

  const requestBootstrapAction = React.useCallback(
    async (action: BootstrapAction) => {
      accept(await window.voice2text.requestBootstrapAction(action));
    },
    [accept],
  );

  return {
    snapshot,
    loadError,
    ...processing,
    navigate,
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
