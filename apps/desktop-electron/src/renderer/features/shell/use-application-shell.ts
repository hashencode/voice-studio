import * as React from "react";

import type {
  ApplicationSnapshot,
  BootstrapAction,
  ShellSection,
} from "@shared/contracts";

export function useApplicationShell() {
  const [snapshot, setSnapshot] = React.useState<ApplicationSnapshot | null>(
    null,
  );
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const deepLinkApplied = React.useRef(false);

  const accept = React.useCallback((next: ApplicationSnapshot) => {
    setSnapshot((current) =>
      !current || next.revision >= current.revision ? next : current,
    );
  }, []);

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
        if (
          deepLink &&
          deepLink !== restored.navigation.section &&
          !deepLinkApplied.current
        ) {
          deepLinkApplied.current = true;
          accept(await window.voice2text.navigate(deepLink));
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
    async (section: ShellSection) => {
      if (snapshot?.navigation.section === section) return;
      window.history.replaceState(null, "", `#/${section}`);
      accept(await window.voice2text.navigate(section));
    },
    [accept, snapshot?.navigation.section],
  );

  const requestBootstrapAction = React.useCallback(
    async (action: BootstrapAction) => {
      accept(await window.voice2text.requestBootstrapAction(action));
    },
    [accept],
  );

  return { snapshot, loadError, navigate, requestBootstrapAction };
}

export function parseShellDeepLink(hash: string): ShellSection | null {
  const value = hash.replace(/^#\/?/, "").split("/")[0];
  return value === "library" ||
    value === "tasks" ||
    value === "companion" ||
    value === "settings"
    ? value
    : null;
}
