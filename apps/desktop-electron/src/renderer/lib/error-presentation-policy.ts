import type { DesktopFailureData } from "@shared/contracts";

export type ErrorPresentationSurface =
  | "application-blocker"
  | "dialog"
  | "alert-dialog"
  | "toast"
  | "inline"
  | "silent";

export type ErrorPresentationContext =
  | { kind: "required-input" }
  | { kind: "required-choice" }
  | { kind: "destructive-confirmation" }
  | { kind: "field-validation" }
  | { kind: "section-retry" }
  | { kind: "non-blocking-result" }
  | { kind: "owned-follow-up" };

export function chooseErrorPresentation(
  failure: DesktopFailureData,
  context: ErrorPresentationContext,
): ErrorPresentationSurface {
  if (
    failure.domain === "application" &&
    failure.applicationAvailability === "unavailable"
  ) {
    return "application-blocker";
  }

  switch (context.kind) {
    case "required-input":
    case "required-choice":
      return "dialog";
    case "destructive-confirmation":
      return "alert-dialog";
    case "field-validation":
    case "section-retry":
      return "inline";
    case "non-blocking-result":
      return "toast";
    case "owned-follow-up":
      return "silent";
  }
}
