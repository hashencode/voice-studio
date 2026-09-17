import { describe, expect, it, vi } from "vitest";

import {
  BootstrapActionRejectedError,
  createBootstrapActionRunner,
  publishReadyLibrary,
  publishStartupCaptureReconciliation,
  runBootstrapTransaction,
} from "../../src/main/application/bootstrap_transaction";
import type { ApplicationSnapshot } from "../../src/shared/contracts";

describe("application bootstrap transaction", () => {
  it("rechecks without resetting the profile", async () => {
    let snapshot = blockedSnapshot("schema_invalid");
    const resetProfile = vi.fn();
    const bootstrap = vi.fn(async () => {
      snapshot = readySnapshot();
    });
    const runner = createBootstrapActionRunner({
      getSnapshot: () => snapshot,
      hasPublishedProfileResources: () => false,
      resetProfile,
      bootstrap,
      restoreBlockedProfile: vi.fn(),
    });

    await expect(runner("recheck")).resolves.toEqual(readySnapshot());
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(resetProfile).not.toHaveBeenCalled();
  });

  it("resets an unpublished schema-invalid profile and bootstraps it once", async () => {
    let snapshot = blockedSnapshot("schema_invalid");
    const resetProfile = vi.fn();
    const bootstrap = vi.fn(async () => {
      snapshot = readySnapshot();
    });
    const runner = createBootstrapActionRunner({
      getSnapshot: () => snapshot,
      hasPublishedProfileResources: () => false,
      resetProfile,
      bootstrap,
      restoreBlockedProfile: vi.fn(),
    });

    await expect(runner("reset-profile")).resolves.toEqual(readySnapshot());
    expect(resetProfile).toHaveBeenCalledOnce();
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(resetProfile.mock.invocationCallOrder[0]).toBeLessThan(
      bootstrap.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    "filesystem_unavailable",
    "legacy_archive_failed",
    "insufficient_space",
    "path_escape",
  ] as const)("rejects reset for %s without deleting", async (code) => {
    const resetProfile = vi.fn();
    const bootstrap = vi.fn(async () => undefined);
    const runner = createBootstrapActionRunner({
      getSnapshot: () => blockedSnapshot(code),
      hasPublishedProfileResources: () => false,
      resetProfile,
      bootstrap,
      restoreBlockedProfile: vi.fn(),
    });

    await expect(runner("reset-profile")).rejects.toBeInstanceOf(
      BootstrapActionRejectedError,
    );
    expect(resetProfile).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("rejects reset after ready or after profile resources are published", async () => {
    const resetProfile = vi.fn();
    const bootstrap = vi.fn(async () => undefined);
    const readyRunner = createBootstrapActionRunner({
      getSnapshot: () => readySnapshot(),
      hasPublishedProfileResources: () => false,
      resetProfile,
      bootstrap,
      restoreBlockedProfile: vi.fn(),
    });
    const publishedRunner = createBootstrapActionRunner({
      getSnapshot: () => blockedSnapshot("schema_invalid"),
      hasPublishedProfileResources: () => true,
      resetProfile,
      bootstrap,
      restoreBlockedProfile: vi.fn(),
    });

    await expect(readyRunner("reset-profile")).rejects.toBeInstanceOf(
      BootstrapActionRejectedError,
    );
    await expect(publishedRunner("reset-profile")).rejects.toBeInstanceOf(
      BootstrapActionRejectedError,
    );
    expect(resetProfile).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("keeps the blocked snapshot when deletion or fresh bootstrap fails", async () => {
    const blocked = blockedSnapshot("schema_invalid");
    const deleteFailureSnapshot = blocked;
    const deleteFailureRunner = createBootstrapActionRunner({
      getSnapshot: () => deleteFailureSnapshot,
      hasPublishedProfileResources: () => false,
      resetProfile: () => {
        throw new Error("delete failed");
      },
      bootstrap: vi.fn(async () => undefined),
      restoreBlockedProfile: vi.fn(),
    });
    await expect(deleteFailureRunner("reset-profile")).rejects.toThrow(
      "delete failed",
    );
    expect(deleteFailureSnapshot).toEqual(blocked);

    let current: ApplicationSnapshot = blocked;
    const restoreBlockedProfile = vi.fn((profile) => {
      current = { ...blocked, revision: blocked.revision + 1, profile };
    });
    const bootstrapFailureRunner = createBootstrapActionRunner({
      getSnapshot: () => current,
      hasPublishedProfileResources: () => false,
      resetProfile: vi.fn(),
      bootstrap: vi.fn(async () => {
        current = { ...blocked, profile: { phase: "initializing" } };
        throw new Error("fresh bootstrap failed");
      }),
      restoreBlockedProfile,
    });
    await expect(bootstrapFailureRunner("reset-profile")).rejects.toThrow(
      "fresh bootstrap failed",
    );
    expect(restoreBlockedProfile).toHaveBeenCalledWith(blocked.profile);
    expect(current.profile).toEqual(blocked.profile);
  });

  it("rejects a reset when fresh bootstrap resolves to another blocker", async () => {
    let snapshot = blockedSnapshot("schema_invalid");
    const runner = createBootstrapActionRunner({
      getSnapshot: () => snapshot,
      hasPublishedProfileResources: () => false,
      resetProfile: vi.fn(),
      bootstrap: vi.fn(async () => {
        snapshot = blockedSnapshot("filesystem_unavailable");
      }),
      restoreBlockedProfile: vi.fn(),
    });

    await expect(runner("reset-profile")).rejects.toThrow(
      "profile reset did not become ready",
    );
    expect(snapshot.profile).toMatchObject({
      phase: "blocked",
      code: "filesystem_unavailable",
    });
  });

  it.each(["recheck", "reset-profile"] as const)(
    "shares one operation for matching %s actions",
    async (action) => {
      const bootstrapCompletion = deferred<void>();
      const bootstrap = vi.fn(() => bootstrapCompletion.promise);
      const resetProfile = vi.fn();
      let snapshot = blockedSnapshot("schema_invalid");
      const runner = createBootstrapActionRunner({
        getSnapshot: () => snapshot,
        hasPublishedProfileResources: () => false,
        resetProfile,
        bootstrap,
        restoreBlockedProfile: vi.fn(),
      });

      const first = runner(action);
      const second = runner(action);
      await Promise.resolve();
      expect(bootstrap).toHaveBeenCalledOnce();
      expect(resetProfile).toHaveBeenCalledTimes(
        action === "reset-profile" ? 1 : 0,
      );
      if (action === "reset-profile") snapshot = readySnapshot();
      bootstrapCompletion.resolve();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(bootstrap).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["recheck", "reset-profile"],
    ["reset-profile", "recheck"],
  ] as const)(
    "rejects concurrent %s then %s",
    async (firstAction, secondAction) => {
      const bootstrapCompletion = deferred<void>();
      let snapshot = blockedSnapshot("schema_invalid");
      const runner = createBootstrapActionRunner({
        getSnapshot: () => snapshot,
        hasPublishedProfileResources: () => false,
        resetProfile: vi.fn(),
        bootstrap: vi.fn(() => bootstrapCompletion.promise),
        restoreBlockedProfile: vi.fn(),
      });

      const first = runner(firstAction);
      await expect(runner(secondAction)).rejects.toBeInstanceOf(
        BootstrapActionRejectedError,
      );
      if (firstAction === "reset-profile") snapshot = readySnapshot();
      bootstrapCompletion.resolve();
      await expect(first).resolves.toEqual(snapshot);
    },
  );

  it("rechecks reset eligibility after acquiring the action gate", async () => {
    let snapshot = blockedSnapshot("schema_invalid");
    const resetProfile = vi.fn();
    const runner = createBootstrapActionRunner({
      getSnapshot: () => snapshot,
      hasPublishedProfileResources: () => false,
      resetProfile,
      bootstrap: vi.fn(async () => undefined),
      restoreBlockedProfile: vi.fn(),
    });

    const reset = runner("reset-profile");
    snapshot = readySnapshot();
    await expect(reset).rejects.toBeInstanceOf(BootstrapActionRejectedError);
    expect(resetProfile).not.toHaveBeenCalled();
  });

  it("does not publish ready when the final library read fails", () => {
    const completeBootstrap = vi.fn();
    const setLibraryCount = vi.fn();

    expect(() =>
      publishReadyLibrary({
        countAudios: () => {
          throw new Error("database read failed");
        },
        completeBootstrap,
        setLibraryCount,
      }),
    ).toThrow("database read failed");
    expect(completeBootstrap).not.toHaveBeenCalled();
    expect(setLibraryCount).not.toHaveBeenCalled();
  });

  it("resets a partial attempt and allows the next recheck to succeed", async () => {
    let ready = false;
    const initialize = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("partial initialization failed"))
      .mockImplementationOnce(async () => {
        ready = true;
      });
    const resetPartialInitialization = vi.fn(async () => undefined);
    const run = () =>
      runBootstrapTransaction({
        isReady: () => ready,
        initialize,
        resetPartialInitialization,
      });

    await expect(run()).rejects.toThrow("partial initialization failed");
    expect(resetPartialInitialization).toHaveBeenCalledOnce();

    await expect(run()).resolves.toBeUndefined();
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(ready).toBe(true);
  });

  it("publishes projected audio count and reports partial startup failures", () => {
    const setLibraryCount = vi.fn();
    const recordFailure = vi.fn();

    publishStartupCaptureReconciliation({
      result: { projected: 2, failed: 1 },
      countAudios: () => 3,
      setLibraryCount,
      recordFailure,
    });

    expect(setLibraryCount).toHaveBeenCalledWith(3);
    expect(recordFailure).toHaveBeenCalledOnce();
  });
});

function blockedSnapshot(
  code:
    | "filesystem_unavailable"
    | "legacy_archive_failed"
    | "insufficient_space"
    | "path_escape"
    | "schema_invalid",
): ApplicationSnapshot {
  return {
    protocolVersion: 3,
    revision: 1,
    navigation: { section: "library" },
    profile: { phase: "blocked", code, message: "blocked", repairable: true },
    connectivity: "online",
    capability: { processing: "available" },
    library: { phase: "error", message: "blocked", retryable: true },
    reconciliation: [],
    capture: { phase: "idle" },
    libraryProjection: { phase: "idle" },
    activity: [],
  };
}

function readySnapshot(): ApplicationSnapshot {
  return {
    ...blockedSnapshot("schema_invalid"),
    revision: 2,
    profile: { phase: "ready", legacyDatabaseArchived: false },
    library: { phase: "empty" },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
