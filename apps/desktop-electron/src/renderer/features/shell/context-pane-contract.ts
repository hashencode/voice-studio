export type RendererShellSection = "audio" | "companion" | "settings";
export type ContextPaneSection = RendererShellSection;
export const SHELL_SECTION_LABELS: Record<RendererShellSection, string> = {
  audio: "音频",
  companion: "互联",
  settings: "设置",
};
export type ContextPanePresentation = "docked" | "overlay";
export type ContextPaneCloseReason =
  "toggle" | "close-button" | "escape" | "background" | "selection";
