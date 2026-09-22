export type RendererShellSection =
  "audio" | "companion" | "messages" | "settings";
export type PersistedShellSection = Exclude<RendererShellSection, "messages">;
export type ContextPaneSection = RendererShellSection;
export const SHELL_SECTION_LABELS: Record<RendererShellSection, string> = {
  audio: "音频",
  companion: "互联",
  messages: "消息",
  settings: "设置",
};
export type ContextPanePresentation = "docked" | "overlay";

export const CONTEXT_PANE_WIDTH = {
  default: 320,
  minimum: 260,
  maximum: 380,
  mainContentMinimum: 480,
} as const;

export const SHELL_GEOMETRY = {
  primaryRailWidth: 49,
  contextPaneOuterBorderWidth: 1,
  collapsedPrefixWidth: 48,
  headerHeight: 50,
  searchBandHeight: 45,
  filtersBandHeight: 37,
  headerControlSize: 28,
  midpointRailWidth: 28,
  midpointRailHeight: 48,
} as const;

export function expandedContextPanePrefixWidth(contextPaneWidth: number) {
  return (
    SHELL_GEOMETRY.primaryRailWidth +
    contextPaneWidth +
    SHELL_GEOMETRY.contextPaneOuterBorderWidth
  );
}
