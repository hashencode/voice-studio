import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { configureRuntimeIdentity } from "../../src/main/application/runtime_identity";
import { runPrimaryInstance } from "../../src/main/application/single_instance";

const mainSource = readFileSync(resolve("src/main/index.ts"), "utf8");

describe("single-instance startup gate", () => {
  it("isolates development runtime data", () => {
    const setName = vi.fn();
    const setPath = vi.fn();

    configureRuntimeIdentity({
      isPackaged: false,
      getPath: (name) => {
        expect(name).toBe("appData");
        return "/Users/test/Library/Application Support";
      },
      setName,
      setPath,
    });

    expect(setName).toHaveBeenCalledWith("Voice2Text Development");
    expect(setPath.mock.calls).toEqual([
      [
        "appData",
        "/Users/test/Library/Application Support/Voice2Text Development",
      ],
      [
        "userData",
        "/Users/test/Library/Application Support/Voice2Text Development/electron-user-data",
      ],
    ]);
  });

  it("preserves the packaged application identity", () => {
    const setName = vi.fn();
    const setPath = vi.fn();

    configureRuntimeIdentity({
      isPackaged: true,
      getPath: vi.fn(),
      setName,
      setPath,
    });

    expect(setName).not.toHaveBeenCalled();
    expect(setPath).not.toHaveBeenCalled();
  });

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
    const appDataSelection = mainSource.indexOf('app.setPath("appData"');
    const userDataSelection = mainSource.indexOf('app.setPath("userData"');
    const instanceLock = mainSource.indexOf("runPrimaryInstance(app");

    expect(appDataSelection).toBeGreaterThan(-1);
    expect(userDataSelection).toBeGreaterThan(-1);
    expect(instanceLock).toBeGreaterThan(-1);
    expect(appDataSelection).toBeLessThan(instanceLock);
    expect(userDataSelection).toBeLessThan(instanceLock);
  });

  it("configures the normal runtime identity before requesting the instance lock", () => {
    const runtimeIdentity = mainSource.indexOf("configureRuntimeIdentity(app)");
    const instanceLock = mainSource.indexOf("runPrimaryInstance(app");

    expect(runtimeIdentity).toBeGreaterThan(-1);
    expect(instanceLock).toBeGreaterThan(-1);
    expect(runtimeIdentity).toBeLessThan(instanceLock);
  });
});
