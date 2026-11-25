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
  default: 300,
  minimum: 260,
  maximum: 380,
  mainContentMinimum: 480,
} as const;

export const SHELL_GEOMETRY = {
  primaryRailWidth: 63,
  workspaceInset: 8,
  workspaceBorderWidth: 1,
  workspaceRadius: 14,
} as const;
