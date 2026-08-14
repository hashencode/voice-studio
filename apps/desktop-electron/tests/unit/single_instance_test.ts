import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runPrimaryInstance } from "../../src/main/application/single_instance";

describe("single-instance startup gate", () => {
  it("quits a second instance before any profile initialization can start", () => {
    const order: string[] = [];
    const quit = vi.fn(() => order.push("quit"));
    const initializePrimary = vi.fn(() => order.push("initialize"));

    expect(
      runPrimaryInstance(
        {
          requestSingleInstanceLock: () => {
            order.push("lock");
            return false;
          },
          quit,
        },
        initializePrimary,
      ),
    ).toBe(false);
    expect(order).toEqual(["lock", "quit"]);
    expect(initializePrimary).not.toHaveBeenCalled();
  });

  it("starts the primary instance only after the lock is held", () => {
    const order: string[] = [];
    expect(
      runPrimaryInstance(
        {
          requestSingleInstanceLock: () => {
            order.push("lock");
            return true;
          },
          quit: vi.fn(),
        },
        () => order.push("initialize"),
      ),
    ).toBe(true);
    expect(order).toEqual(["lock", "initialize"]);
  });

  it("selects isolated packaged-smoke paths before requesting the instance lock", () => {
    const mainSource = readFileSync(resolve("src/main/index.ts"), "utf8");
    const appDataSelection = mainSource.indexOf('app.setPath("appData"');
    const userDataSelection = mainSource.indexOf('app.setPath("userData"');
    const instanceLock = mainSource.indexOf("runPrimaryInstance(app");

    expect(appDataSelection).toBeGreaterThan(-1);
    expect(userDataSelection).toBeGreaterThan(-1);
    expect(instanceLock).toBeGreaterThan(-1);
    expect(appDataSelection).toBeLessThan(instanceLock);
    expect(userDataSelection).toBeLessThan(instanceLock);
  });
});
