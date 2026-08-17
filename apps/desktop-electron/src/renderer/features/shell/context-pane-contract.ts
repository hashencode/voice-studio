export type RendererShellSection = "audio" | "companion" | "settings";
export type ContextPaneSection = Exclude<RendererShellSection, "settings">;
export type ContextPanePresentation = "docked" | "overlay";
export type ContextPaneCloseReason =
  "toggle" | "close-button" | "escape" | "background";
