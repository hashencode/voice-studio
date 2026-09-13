import { describe, expect, it } from "vitest";

import { chooseErrorPresentation } from "@/lib/error-presentation-policy";
import type { DesktopFailureData } from "@shared/contracts";

const refreshFailure: DesktopFailureData = {
  protocolVersion: 3,
  domain: "transport",
  code: "IPC_DISCONNECTED",
  retryable: true,
  fallback: "try-again",
};

describe("renderer error presentation policy", () => {
  it("keeps an explicitly unavailable application on the blocker surface", () => {
    const unavailable: DesktopFailureData = {
      protocolVersion: 3,
      domain: "application",
      code: "APPLICATION_UNAVAILABLE",
      retryable: false,
      fallback: "restart-application",
      applicationAvailability: "unavailable",
    };

    expect(
      chooseErrorPresentation(unavailable, { kind: "non-blocking-result" }),
    ).toBe("application-blocker");
  });

  it("uses one non-blocking surface when stale content remains usable", () => {
    expect(
      chooseErrorPresentation(refreshFailure, {
        kind: "non-blocking-result",
      }),
    ).toBe("toast");
    expect(
      chooseErrorPresentation(refreshFailure, { kind: "section-retry" }),
    ).toBe("inline");
  });

  it("distinguishes input, choice, validation, confirmation, and silent follow-up", () => {
    expect(
      chooseErrorPresentation(refreshFailure, { kind: "required-input" }),
    ).toBe("dialog");
    expect(
      chooseErrorPresentation(refreshFailure, { kind: "required-choice" }),
    ).toBe("dialog");
    expect(
      chooseErrorPresentation(refreshFailure, { kind: "field-validation" }),
    ).toBe("inline");
    expect(
      chooseErrorPresentation(refreshFailure, {
        kind: "destructive-confirmation",
      }),
    ).toBe("alert-dialog");
    expect(
      chooseErrorPresentation(refreshFailure, { kind: "owned-follow-up" }),
    ).toBe("silent");
  });
});
