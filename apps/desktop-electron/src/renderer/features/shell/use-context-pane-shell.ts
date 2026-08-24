import * as React from "react";

import type {
  ContextPaneSection,
  RendererShellSection,
} from "@/features/shell/context-pane-contract";

type PanePreference = "open" | "closed";
type PanePreferences = Record<ContextPaneSection, PanePreference>;

const CONTEXT_PANE_STORAGE_KEY = "voice2text.shell.context-panes.v1";
const DEFAULT_PREFERENCES: PanePreferences = {
  audio: "open",
  companion: "open",
  messages: "open",
  settings: "open",
};

export function useContextPaneShell(section: RendererShellSection) {
  const [preferences, setPreferences] = React.useState(readPanePreferences);
  const preferencesRef = React.useRef(preferences);
  const presentation = "docked" as const;
  const paneSection = section;
  const open = preferences[paneSection] === "open";

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

  const requestClose = React.useCallback(() => {
    updatePreference(paneSection, "closed");
  }, [paneSection, updatePreference]);

  const toggle = React.useCallback(() => {
    updatePreference(paneSection, open ? "closed" : "open");
  }, [open, paneSection, updatePreference]);

  const openPane = React.useCallback(
    (target: ContextPaneSection = paneSection) => {
      updatePreference(target, "open");
    },
    [paneSection, updatePreference],
  );

  return {
    open,
    paneSection,
    presentation,
    requestClose,
    toggle,
    openPane,
  };
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
      messages: value.messages === "closed" ? "closed" : "open",
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
