import * as React from "react";

import type {
  ContextPaneCloseReason,
  ContextPanePresentation,
  ContextPaneSection,
  RendererShellSection,
} from "@/features/shell/context-pane-contract";

type PanePreference = "open" | "closed";
type PanePreferences = Record<ContextPaneSection, PanePreference>;

const CONTEXT_PANE_STORAGE_KEY = "voice2text.shell.context-panes.v1";
const CONTEXT_PANE_BREAKPOINT = 1024;
const DEFAULT_PREFERENCES: PanePreferences = {
  audio: "open",
  companion: "open",
  settings: "open",
};
const PERSISTENT_CLOSE_REASONS: ReadonlySet<ContextPaneCloseReason> = new Set([
  "toggle",
  "escape",
  "background",
]);

export function useContextPaneShell(section: RendererShellSection) {
  const [preferences, setPreferences] = React.useState(readPanePreferences);
  const [transientClosedSection, setTransientClosedSection] =
    React.useState<ContextPaneSection | null>(null);
  const preferencesRef = React.useRef(preferences);
  const presentation = useContextPanePresentation();
  const paneSection = section;
  const open =
    preferences[paneSection] === "open" &&
    transientClosedSection !== paneSection;

  const updatePreference = React.useCallback(
    (target: ContextPaneSection, preference: PanePreference) => {
      if (preferencesRef.current[target] === preference) return;
      const next = { ...preferencesRef.current, [target]: preference };
      preferencesRef.current = next;
      setPreferences(next);
      writePanePreferences(next);
    },
    [],
  );

  const requestClose = React.useCallback(
    (reason: ContextPaneCloseReason) => {
      if (reason === "selection") {
        setTransientClosedSection(paneSection);
        return;
      }
      if (!PERSISTENT_CLOSE_REASONS.has(reason)) return;
      setTransientClosedSection(null);
      updatePreference(paneSection, "closed");
    },
    [paneSection, updatePreference],
  );

  const toggle = React.useCallback(() => {
    setTransientClosedSection(null);
    updatePreference(paneSection, open ? "closed" : "open");
  }, [open, paneSection, updatePreference]);

  const openPane = React.useCallback(
    (target: ContextPaneSection = paneSection) => {
      if (target === paneSection) setTransientClosedSection(null);
      updatePreference(target, "open");
    },
    [paneSection, updatePreference],
  );

  const clearTransientClose = React.useCallback(() => {
    setTransientClosedSection(null);
  }, []);

  return {
    open,
    paneSection,
    presentation,
    requestClose,
    toggle,
    openPane,
    clearTransientClose,
  };
}

function useContextPanePresentation(): ContextPanePresentation {
  const [presentation, setPresentation] =
    React.useState<ContextPanePresentation>(deriveContextPanePresentation);

  React.useEffect(() => {
    const handleResize = () => setPresentation(deriveContextPanePresentation());
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return presentation;
}

function deriveContextPanePresentation(): ContextPanePresentation {
  return window.innerWidth < CONTEXT_PANE_BREAKPOINT ? "overlay" : "docked";
}

function readPanePreferences(): PanePreferences {
  try {
    const stored = window.localStorage.getItem(CONTEXT_PANE_STORAGE_KEY);
    if (!stored) return DEFAULT_PREFERENCES;
    const value: unknown = JSON.parse(stored);
    if (!isRecord(value)) return DEFAULT_PREFERENCES;
    return {
      audio: value.audio === "closed" ? "closed" : "open",
      companion: value.companion === "closed" ? "closed" : "open",
      settings: value.settings === "closed" ? "closed" : "open",
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function writePanePreferences(preferences: PanePreferences) {
  try {
    window.localStorage.setItem(
      CONTEXT_PANE_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // A denied storage write must not make the shell unusable.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
