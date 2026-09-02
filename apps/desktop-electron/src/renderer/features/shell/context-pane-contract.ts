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

export const SHELL_GEOMETRY = {
  primaryRailWidth: 49,
  contextPaneWidth: 391,
  expandedPrefixWidth: 440,
  headerHeight: 50,
  searchBandHeight: 45,
  headerControlSize: 28,
  midpointRailWidth: 28,
  midpointRailHeight: 48,
} as const;
