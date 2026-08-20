import { describe, expect, it } from "vitest";

import {
  deriveFloatingCaptureSnapshot,
  hasSameFloatingCapturePresentation,
} from "../../src/main/application/floating_capture_projection";
import type { ApplicationSnapshot } from "../../src/shared/contracts";

function application(
  capture: ApplicationSnapshot["capture"],
): ApplicationSnapshot {
  return {
    protocolVersion: 2,
    revision: 7,
    navigation: { section: "library" },
    profile: { phase: "ready", legacyDatabaseArchived: false },
    connectivity: "online",
    capability: { processing: "available" },
    library: { phase: "empty" },
    reconciliation: [],
    capture,
  };
}

describe("floating capture projection", () => {
  it("redacts title, messages, and unrelated application state", () => {
    const projected = deriveFloatingCaptureSnapshot(
      application({
        phase: "recording",
        sessionId: "session-private-123456",
        title: "private meeting",
        elapsedMs: 9_000,
        message: "/private/path/raw error",
      }),
    );
    expect(projected).toEqual({
      revision: 7,
      sessionId: "session-private-123456",
      phase: "recording",
      elapsedMs: 9_000,
      allowedActions: ["pause", "stop"],
      attention: false,
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /private meeting|private\/path/,
    );
  });

  it("maps paused, finalizing, attention, and idle states", () => {
    expect(
      deriveFloatingCaptureSnapshot(
        application({
          phase: "paused",
          sessionId: "session-paused-123456",
          title: "hidden",
          elapsedMs: 1,
        }),
      ).allowedActions,
    ).toEqual(["resume", "stop"]);
    expect(
      deriveFloatingCaptureSnapshot(
        application({
          phase: "finalizing",
          sessionId: "session-finalize-123456",
          title: "hidden",
          elapsedMs: 2,
        }),
      ).phase,
    ).toBe("finalizing");
    expect(
      deriveFloatingCaptureSnapshot(
        application({
          phase: "failed",
          sessionId: "session-failed-123456",
          title: "hidden",
          elapsedMs: 3,
        }),
      ),
    ).toMatchObject({ phase: "attention", attention: true });
    expect(
      deriveFloatingCaptureSnapshot(application({ phase: "idle" })).phase,
    ).toBe("idle");
  });

  it("ignores revision-only changes when deciding whether to broadcast", () => {
    const projected = deriveFloatingCaptureSnapshot(
      application({
        phase: "recording",
        sessionId: "session-stable-123456",
        title: "hidden",
        elapsedMs: 9_000,
      }),
    );
    expect(
      hasSameFloatingCapturePresentation(projected, {
        ...projected,
        revision: projected.revision + 1,
      }),
    ).toBe(true);
    expect(
      hasSameFloatingCapturePresentation(projected, {
        ...projected,
        elapsedMs: projected.elapsedMs + 500,
      }),
    ).toBe(false);
  });

  it("keeps a live partial track controllable and final partial capture attention-only", () => {
    expect(
      deriveFloatingCaptureSnapshot(
        application({
          phase: "partial_capture",
          sessionId: "session-partial-live-123456",
          title: "hidden",
          elapsedMs: 4_000,
          systemAudioHealthy: true,
          microphoneHealthy: false,
        }),
      ),
    ).toMatchObject({
      phase: "recording",
      allowedActions: ["pause", "stop"],
      attention: false,
    });
    expect(
      deriveFloatingCaptureSnapshot(
        application({
          phase: "partial_capture",
          sessionId: "session-partial-final-123456",
          title: "hidden",
          elapsedMs: 4_000,
          systemAudioHealthy: false,
          microphoneHealthy: false,
        }),
      ),
    ).toMatchObject({
      phase: "attention",
      allowedActions: [],
      attention: true,
    });
  });
});
