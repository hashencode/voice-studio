import { describe, expect, it, vi } from "vitest";

import {
  publishReadyLibrary,
  publishStartupCaptureReconciliation,
  runBootstrapTransaction,
} from "../../src/main/application/bootstrap_transaction";

describe("application bootstrap transaction", () => {
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
