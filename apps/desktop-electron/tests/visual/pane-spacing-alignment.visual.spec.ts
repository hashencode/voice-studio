import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";
import electronExecutable from "electron";

import {
  buildVisualFixture,
  type VisualScenario,
} from "./fixtures/renderer-api";

const harnessMain = path.resolve("tests/visual/.harness-build/main.js");
const harnessPreload = path.resolve("tests/visual/.harness-build/preload.js");
const rendererUrl = "http://127.0.0.1:4179";

test("uses the shared 260-320-380 pane contract", async () => {
  await withVisualSession("settings", 1280, 720, async ({ page }) => {
    const handle = page.getByRole("separator", {
      name: "调整设置上下文面板宽度",
    });
    await expect(handle).toHaveAttribute("aria-valuemin", "260");
    await expect(handle).toHaveAttribute("aria-valuemax", "380");
    await expect(handle).toHaveAttribute("aria-valuenow", "320");
    await screenshot(page, "aligned-voice-settings-320.png");

    await handle.press("Home");
    await expect(handle).toHaveAttribute("aria-valuenow", "260");
    await screenshot(page, "aligned-voice-settings-260.png");

    await handle.press("End");
    await expect(handle).toHaveAttribute("aria-valuenow", "380");
    await screenshot(page, "aligned-voice-settings-380.png");

    await page.getByRole("button", { name: "录制", exact: true }).click();
    await expect(
      page.getByRole("separator", { name: "调整设置上下文面板宽度" }),
    ).toHaveAttribute("aria-valuenow", "380");
  });
});

test("reports the effective maximum at the supported minimum window", async () => {
  await withVisualSession("settings", 880, 620, async ({ page }) => {
    const handle = page.getByRole("separator", {
      name: "调整设置上下文面板宽度",
    });
    await expect(handle).toHaveAttribute("aria-valuemax", "350");
    await handle.press("End");
    await expect(handle).toHaveAttribute("aria-valuenow", "350");
    await screenshot(page, "aligned-voice-settings-minimum-350.png");
  });
});

async function withVisualSession(
  scenario: VisualScenario,
  width: number,
  height: number,
  run: (session: Awaited<ReturnType<typeof launch>>) => Promise<void>,
) {
  const session = await launch(scenario, width, height);
  try {
    await run(session);
    expect(session.rendererErrors).toEqual([]);
  } finally {
    await session.app.close();
  }
}

async function launch(scenario: VisualScenario, width: number, height: number) {
  const app = await electron.launch({
    executablePath: electronExecutable as unknown as string,
    args: [harnessMain],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      VOICE2TEXT_VISUAL_FIXTURE: JSON.stringify(buildVisualFixture(scenario)),
      VOICE2TEXT_VISUAL_HEIGHT: String(height),
      VOICE2TEXT_VISUAL_PRELOAD: harnessPreload,
      VOICE2TEXT_VISUAL_WIDTH: String(width),
    },
  });
  try {
    const page = await app.firstWindow();
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await page.emulateMedia({
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    await app.evaluate(async ({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Visual BrowserWindow is unavailable");
      window.webContents.setZoomFactor(1);
      await window.loadURL(url);
    }, rendererUrl);
    await page.waitForLoadState("networkidle");
    const nativeDpr = await page.evaluate(() => window.devicePixelRatio);
    await app.evaluate(({ BrowserWindow }, zoomFactor) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Visual BrowserWindow is unavailable");
      window.webContents.setZoomFactor(zoomFactor);
    }, 1 / nativeDpr);
    return { app, page, rendererErrors };
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function screenshot(
  page: Awaited<ReturnType<typeof launch>>["page"],
  name: string,
) {
  const png = await page.screenshot({ animations: "disabled", caret: "hide" });
  expect(png).toMatchSnapshot(name);
}
