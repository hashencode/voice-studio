import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { _electron as electron, expect, test } from "@playwright/test";
import electronExecutable from "electron";
import renderReference from "./references/reui-app-shell-4-render.json";

import {
  buildVisualFixture,
  type VisualScenario,
  VISUAL_NOW_MS,
} from "./fixtures/renderer-api";

const harnessMain = path.resolve("tests/visual/.harness-build/main.js");
const harnessPreload = path.resolve("tests/visual/.harness-build/preload.js");
const rendererUrl = "http://127.0.0.1:4179";
const canonicalScreenshots =
  process.platform === "darwin" && process.arch === "arm64";
const PRODUCT_CONTEXT_PANE_WIDTH = 300;
const PRODUCT_CONTEXT_PANE_MINIMUM = 260;
const PRODUCT_CONTEXT_PANE_MAXIMUM = 380;
const PRODUCT_MAIN_CONTENT_MINIMUM = 480;
const PRIMARY_RAIL_WIDTH = 63;
const WORKSPACE_INSET = 8;
const WORKSPACE_BORDER = 1;

test.describe("App Shell 8 production Renderer", () => {
  test.beforeAll(() => {
    // This guards evidence integrity, not same-session visual acceptance.
    const image = readFileSync(
      path.resolve(
        "tests/visual/references",
        renderReference.referenceImage.path,
      ),
    );
    expect(createHash("sha256").update(image).digest("hex")).toBe(
      renderReference.referenceImage.sha256,
    );
    const rawEvidence = readFileSync(
      path.resolve("tests/visual/references", renderReference.rawEvidence.path),
    );
    expect(createHash("sha256").update(rawEvidence).digest("hex")).toBe(
      renderReference.rawEvidence.sha256,
    );
    const canonicalEvidence = `${JSON.stringify(sortEvidenceKeys(renderReference.evidence))}\n`;
    expect(createHash("sha256").update(canonicalEvidence).digest("hex")).toBe(
      renderReference.evidenceSha256,
    );
  });

  test("1280x720 Audio App Shell 8 workspace", async () => {
    await withVisualSession("audio-closed", 1280, 720, async (session) => {
      const { page } = session;
      await expect(
        page.getByRole("complementary", { name: "音频上下文面板" }),
      ).toBeVisible();

      await page.getByRole("button", { name: "打开 产品设计评审.wav" }).click();
      await expect(
        page.getByRole("heading", { name: "产品设计评审.wav", level: 1 }),
      ).toBeVisible();
      await assertRuntimeContract(page, 1280, 720);
      await assertDockedGeometry(page, 1280, 720);

      await assertFlatRows(page, "音频列表");
      await screenshot(session, "audio-app-shell-8.png", 1280, 720);
    });
  });

  test("1280x720 Audio open, selected, active capture", async () => {
    await withVisualSession("audio-active", 1280, 720, async (session) => {
      const { page } = session;
      await expect(
        page.locator('[data-shell-slot="content-head"]'),
      ).toContainText("产品设计评审");
      await expect(
        page.getByRole("complementary", { name: "音频上下文面板" }),
      ).toHaveCount(0);
      await expect(page.getByRole("region", { name: "录制详情" })).toHaveCount(
        1,
      );
      await expect(
        page.locator('[data-shell-slot="content-footer"]'),
      ).toContainText("正在录制");

      const headerHeight = await page.evaluate(
        () =>
          document
            .querySelector<HTMLElement>('[data-slot="sidebar-inset"] > header')!
            .getBoundingClientRect().height,
      );
      expectWithin(headerHeight, 50);

      await assertRuntimeContract(page, 1280, 720);
      await assertRailOnlyGeometry(page, 1280, 720, false, false);
      await assertCaptureContainment(page, 1280, 720, false);
      await screenshot(
        session,
        "audio-open-selected-active-capture.png",
        1280,
        720,
      );
    });
  });

  test("context chrome preserves hover, selection, focus and disabled states", async () => {
    await withVisualSession("audio-closed", 1280, 720, async ({ page }) => {
      await expect(
        page.getByRole("button", { name: "前进", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "筛选音频：全部" }),
      ).toBeEnabled();
      const rows = page
        .getByRole("list", { name: "音频列表" })
        .locator("button[data-flat-row]");
      const row = rows.nth(1);
      await row.hover();
      await expect(row).toHaveCSS(
        "background-color",
        renderReference.evidence.controls.listRow.hoverBackground,
      );
      await row.click();
      await page.mouse.move(1200, 10);
      await expect(row).toHaveAttribute("aria-current", "true");
      await expect(row).toHaveCSS(
        "background-color",
        renderReference.evidence.controls.listRow.selectedBackground,
      );
      const search = page.getByRole("searchbox", {
        name: "搜索音频",
        exact: true,
      });
      const unfocusedBorder = await search.evaluate(
        (element) => getComputedStyle(element).borderColor,
      );
      await search.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(search).toBeFocused();
      const focus = await search.evaluate((element) => ({
        visible: element.matches(":focus-visible"),
        border: getComputedStyle(element).borderColor,
        borderWidth: getComputedStyle(element).borderWidth,
        shadow: getComputedStyle(element).boxShadow,
      }));
      expect(focus.visible).toBe(true);
      expect(focus.border).not.toBe(unfocusedBorder);
      expect(focus.borderWidth).toBe("1px");
      expect(focus.shadow).toBe("none");
    });
  });

  test("1280x720 Audio pane closed", async () => {
    await withVisualSession("audio-closed", 1280, 720, async (session) => {
      const { page } = session;
      await expect(
        page.getByText("请选择左侧音频", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "导入音频" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "收起音频上下文面板" }).click();
      await expect(
        page.getByRole("complementary", { name: "音频上下文面板" }),
      ).toBeHidden();
      await expect(
        page.getByRole("button", { name: "打开音频上下文面板" }),
      ).toBeVisible();
      await expect(
        page.getByText("请选择左侧音频", { exact: true }),
      ).toBeVisible();

      await assertRuntimeContract(page, 1280, 720);
      await assertRailOnlyGeometry(page, 1280, 720);

      await screenshot(session, "audio-pane-closed.png", 1280, 720);
    });
  });

  test("1240x820 Empty audio library and recording ready", async () => {
    await withVisualSession("audio-empty", 1240, 820, async (session) => {
      const { page } = session;
      const emptyHeading = page.getByRole("heading", {
        name: "开始你的第一段音频",
      });
      await expect(emptyHeading).toBeVisible();
      await expect(
        page.getByRole("region", { name: "开始你的第一段音频" }),
      ).toBeVisible();
      await expect(
        page.getByRole("complementary", { name: "音频上下文面板" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /音频上下文面板/ }),
      ).toHaveCount(0);

      await assertAudioFirstUseGeometry(page);

      await assertRuntimeContract(page, 1240, 820);
      await assertRailOnlyGeometry(page, 1240, 820, false);
      await screenshot(session, "audio-empty-recording-ready.png", 1240, 820);
    });
  });

  test("880x620 Empty audio library respects the production minimum window", async () => {
    await withVisualSession("audio-empty", 880, 620, async (session) => {
      const { page } = session;
      await expect(
        page.getByRole("heading", { name: "开始你的第一段音频" }),
      ).toBeVisible();

      await assertAudioFirstUseGeometry(page);
      await assertRuntimeContract(page, 880, 620);
      await assertRailOnlyGeometry(page, 880, 620, false);
      await screenshot(
        session,
        "audio-empty-recording-ready-minimum.png",
        880,
        620,
      );
    });
  });

  test("1280x720 Settings", async () => {
    await withVisualSession("settings", 1280, 720, async (session) => {
      const { page } = session;
      await expect(
        page.getByRole("heading", { name: "通用", level: 1 }),
      ).toBeVisible();
      await assertRuntimeContract(page, 1280, 720);
      await assertDockedGeometry(page, 1280, 720);

      await screenshot(session, "settings.png", 1280, 720);
    });
  });

  test("880x620 selected Audio keeps a long title and its actions reachable in dark mode", async () => {
    await withVisualSession("audio-closed", 880, 620, async (session) => {
      const { page } = session;
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      await page.getByRole("button", { name: "打开 产品设计评审.wav" }).click();
      await page.getByRole("button", { name: "编辑音频标题" }).click();
      const editor = page.getByRole("textbox", { name: "音频标题" });
      const title = "本地音频设计评审与项目事项讨论".repeat(5);
      await editor.fill(title);
      await editor.press("Enter");
      await expect(
        page.getByRole("heading", { name: title, level: 1 }),
      ).toBeVisible();

      const resizeHandle = page.getByRole("separator", {
        name: "调整音频上下文面板宽度",
      });
      await resizeHandle.press("End");
      await assertDockedGeometry(page, 880, 620, 327);
      await expect(page.getByRole("button", { name: "导出" })).toBeInViewport();
      await expect(
        page.getByRole("button", { name: "播放音频" }),
      ).toBeInViewport();

      const tabs = page.getByRole("tablist", { name: "音频内容" });
      const content = page.locator("#main-content");
      await content.evaluate((element) => {
        element.scrollTop = 300;
      });
      expect((await tabs.boundingBox())?.y).toBe(
        (await content.boundingBox())?.y,
      );
      await screenshot(session, "audio-dark-minimum.png", 880, 620);
    });
  });

  test("1280x720 Activity messages with detail", async () => {
    await withVisualSession("activity-messages", 1280, 720, async (session) => {
      const { page } = session;
      await page.getByRole("button", { name: "消息，有未读消息" }).click();
      await page.getByRole("button", { name: /本地处理异常/ }).click();
      await expect(
        page.getByRole("region", { name: "消息详情" }),
      ).toContainText("MODEL_LOAD_FAILED");

      await assertRuntimeContract(page, 1280, 720);
      await assertDockedGeometry(page, 1280, 720);
      await expect(
        page.locator('[data-shell-slot="content-head"]'),
      ).toHaveCount(0);
      await screenshot(session, "activity-messages.png", 1280, 720);
    });
  });

  test("880x620 docked Audio with capture recovery dialog", async () => {
    await withVisualSession("audio-recovery", 880, 620, async (session) => {
      const { page } = session;
      await expect(
        page.getByRole("complementary", { name: "录制控制" }),
      ).toHaveCount(0);
      const recoveryDialog = page.getByRole("dialog", {
        name: "发现可恢复的录音",
      });
      await expect(recoveryDialog).toBeVisible();
      await expect(
        recoveryDialog.getByText(
          "发现 6 段可恢复录音。下方操作会处理本批全部录音。",
        ),
      ).toBeVisible();
      await expect(
        recoveryDialog.getByText("Recover-产品设计评审 1"),
      ).toHaveCount(0);
      await expect(
        recoveryDialog.getByRole("button", { name: "立即恢复" }),
      ).toBeVisible();
      await expect(
        recoveryDialog.getByRole("button", { name: "删除数据" }),
      ).toBeVisible();
      await expect(page.getByRole("region", { name: "录制详情" })).toHaveCount(
        0,
      );
      await expect(
        page.locator('[data-shell-slot="content-footer"]'),
      ).toHaveCount(0);

      await assertRuntimeContract(page, 880, 620);
      await assertDockedGeometry(page, 880, 620);
      const dialogGeometry = await recoveryDialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          rect: {
            x: rect.x,
            y: rect.y,
            right: rect.right,
            bottom: rect.bottom,
          },
        };
      });
      expect(dialogGeometry.rect.x).toBeGreaterThanOrEqual(0);
      expect(dialogGeometry.rect.y).toBeGreaterThanOrEqual(0);
      expect(dialogGeometry.rect.right).toBeLessThanOrEqual(880);
      expect(dialogGeometry.rect.bottom).toBeLessThanOrEqual(620);
      await screenshot(session, "audio-overlay-capture-recovery.png", 880, 620);
    });
  });

  test("1280x720 Companion with multiple devices", async () => {
    await withVisualSession("companion-devices", 1280, 720, async (session) => {
      const { page } = session;
      const pane = page.getByRole("complementary", { name: "互联上下文面板" });
      await expect(
        pane.getByRole("button", { name: /Studio 的 iPhone/ }),
      ).toBeVisible();
      await expect(
        pane.getByRole("button", { name: /外勤录音机/ }),
      ).toBeVisible();
      await pane.getByRole("button", { name: /Studio 的 iPhone/ }).click();
      await expect(
        page.getByRole("heading", { name: "Studio 的 iPhone", level: 1 }),
      ).toBeVisible();

      await assertRuntimeContract(page, 1280, 720);
      await assertDockedGeometry(page, 1280, 720);

      await assertFlatRows(page, "已信任设备列表");
      await screenshot(session, "companion-multiple-devices.png", 1280, 720);
    });
  });

  test("shares runtime pane resizing, preserves requested width through viewport clamps, and resets on reload", async () => {
    await withVisualSession("pane-resize", 1280, 720, async (session) => {
      const { page } = session;
      await assertDockedGeometry(page, 1280, 720, PRODUCT_CONTEXT_PANE_WIDTH);

      const resizeHandle = page.getByRole("separator", {
        name: "调整音频上下文面板宽度",
      });
      await dragPaneDivider(page, "upper", 40);
      await assertDockedGeometry(page, 1280, 720, 340);
      await dragPaneDivider(page, "lower", 60);
      await expect(resizeHandle).toHaveAttribute(
        "aria-valuenow",
        String(PRODUCT_CONTEXT_PANE_MAXIMUM),
      );
      await assertDockedGeometry(page, 1280, 720, PRODUCT_CONTEXT_PANE_MAXIMUM);

      const collapseButton = page.getByRole("button", {
        name: "收起音频上下文面板",
      });
      await collapseButton.click();
      await assertRailOnlyGeometry(page, 1280, 720);
      await page.getByRole("button", { name: "打开音频上下文面板" }).click();
      await assertDockedGeometry(page, 1280, 720, PRODUCT_CONTEXT_PANE_MAXIMUM);
      await expect(
        page.getByRole("complementary", { name: "音频上下文面板" }),
      ).toBeVisible();

      for (const target of [
        { navigation: /^互联$/, pane: "互联上下文面板" },
        { navigation: /^消息/, pane: "消息上下文面板" },
        { navigation: /^设置$/, pane: "设置上下文面板" },
        { navigation: /^音频$/, pane: "音频上下文面板" },
      ]) {
        await page
          .getByRole("navigation", { name: "工作站主导航" })
          .getByRole("button", { name: target.navigation })
          .click();
        await expect(
          page.getByRole("complementary", { name: target.pane }),
        ).toBeVisible();
        await assertDockedGeometry(
          page,
          1280,
          720,
          PRODUCT_CONTEXT_PANE_MAXIMUM,
        );
      }

      await resizeVisualWindow(session, 880, 720);
      await assertDockedGeometry(page, 880, 720, 327);
      await resizeVisualWindow(session, 1280, 720);
      await assertDockedGeometry(page, 1280, 720, PRODUCT_CONTEXT_PANE_MAXIMUM);

      await page.reload();
      await page.waitForLoadState("networkidle");
      await assertDockedGeometry(page, 1280, 720, PRODUCT_CONTEXT_PANE_WIDTH);
    });
  });

  test("320x96 privacy-safe floating capture control", async () => {
    const session = await launch(
      "audio-active",
      320,
      96,
      `${rendererUrl}/floating.html`,
    );
    try {
      const { page } = session;
      await expect(
        page.getByRole("main", {
          name: "Voice2Text 录制悬浮控制",
        }),
      ).toBeVisible();
      await expect(page.getByText("正在录制")).toBeVisible();
      await expect(page.getByText("01:12")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "暂停录制" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "停止并保存" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "暂停录制" }).click();
      await expect(page.getByText("录制已暂停")).toBeVisible();
      await page.getByRole("button", { name: "继续录制" }).click();
      await expect(page.getByText("正在录制")).toBeVisible();
      expect(await page.locator("body").innerText()).not.toMatch(
        /标题|转写|路径/,
      );
      await screenshot(session, "floating-capture-recording.png", 320, 96);
    } finally {
      await session.app.close();
    }
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

async function launch(
  scenario: VisualScenario,
  width: number,
  height: number,
  targetUrl = rendererUrl,
) {
  const fixture = buildVisualFixture(scenario);
  const app = await electron.launch({
    executablePath: electronExecutable as unknown as string,
    args: [harnessMain],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      VOICE2TEXT_VISUAL_FIXTURE: JSON.stringify(fixture),
      VOICE2TEXT_VISUAL_HEIGHT: String(height),
      VOICE2TEXT_VISUAL_PRELOAD: harnessPreload,
      VOICE2TEXT_VISUAL_WIDTH: String(width),
    },
  });
  try {
    const page = await app.firstWindow();
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      // index.html:7 predates this change; Chromium rejects frame-ancestors in meta.
      // Keep that known diagnostic visible without changing the product CSP here.
      if (
        text ===
        "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element."
      ) {
        test.info().annotations.push({
          type: "known-console-diagnostic",
          description: text,
        });
      } else {
        rendererErrors.push(text);
      }
    });
    const electronRuntime = await app.evaluate(({ app: electronApp }) => ({
      electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      platform: process.platform,
      arch: process.arch,
      locale: electronApp.getLocale(),
    }));
    expect(electronRuntime).toEqual({
      electronVersion: "43.4.0",
      chromiumVersion: "150.0.7871.224",
      platform: process.platform,
      arch: process.arch,
      locale: "zh-CN",
    });
    await page.addInitScript((epochMs: number) => {
      Date.now = () => epochMs;
      localStorage.clear();
      const applyHarnessCss = () => {
        document.documentElement.classList.remove("dark");
        document.documentElement.style.colorScheme = "light";
        if (!document.querySelector('[data-visual-harness="motion"]')) {
          const style = document.createElement("style");
          style.dataset.visualHarness = "motion";
          style.textContent = `
          *, *::before, *::after {
            animation: none !important;
            transition: none !important;
            caret-color: transparent !important;
          }
        `;
          document.head.append(style);
        }
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", applyHarnessCss, {
          once: true,
        });
      } else {
        applyHarnessCss();
      }
    }, VISUAL_NOW_MS);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await app.evaluate(async ({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Visual BrowserWindow is unavailable");
      window.webContents.setZoomFactor(1);
      await window.loadURL(url);
    }, targetUrl);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Visual BrowserWindow is unavailable");
      window.webContents.setZoomFactor(1);
    });
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

async function assertRuntimeContract(
  page: Awaited<ReturnType<typeof launch>>["page"],
  width: number,
  height: number,
) {
  const runtime = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
    language: navigator.language,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    fontFamily: getComputedStyle(document.body)
      .fontFamily.split(",")
      .slice(0, 2)
      .map((family) => family.trim().replaceAll('"', "")),
    frozenNow: Date.now(),
  }));
  expect(runtime).toEqual({
    width,
    height,
    dpr: 1,
    language: "zh-CN",
    colorScheme: "light",
    reducedMotion: true,
    fontFamily: ["system-ui", "-apple-system"],
    frozenNow: Date.UTC(2026, 7, 19, 3, 20, 0),
  });
}

async function assertDockedGeometry(
  page: Awaited<ReturnType<typeof launch>>["page"],
  width: number,
  height: number,
  contextPaneWidth = PRODUCT_CONTEXT_PANE_WIDTH,
) {
  await expect
    .poll(async () => (await shellGeometry(page)).track?.width)
    .toBe(contextPaneWidth);
  const geometry = await assertFramedWorkspace(page, width, height);
  const {
    track,
    pane,
    resizeHandle,
    midpointRail,
    upperResizeHitArea,
    lowerResizeHitArea,
  } = geometry;
  if (
    !track ||
    !pane ||
    !resizeHandle ||
    !midpointRail ||
    !upperResizeHitArea ||
    !lowerResizeHitArea
  ) {
    throw new Error("Expected the docked pane and its controls");
  }
  expectRect(pane, track);
  expectWithin(pane.width, contextPaneWidth);
  expectWithin(resizeHandle.x + resizeHandle.width / 2, track.right);
  expectWithin(geometry.resizeHandleValue!, contextPaneWidth);
  expectWithin(geometry.resizeHandleMinimum!, PRODUCT_CONTEXT_PANE_MINIMUM);
  expectWithin(
    geometry.resizeHandleMaximum!,
    Math.min(
      PRODUCT_CONTEXT_PANE_MAXIMUM,
      width -
        PRIMARY_RAIL_WIDTH -
        WORKSPACE_INSET -
        2 * WORKSPACE_BORDER -
        PRODUCT_MAIN_CONTENT_MINIMUM,
    ),
  );
  expectWithin(midpointRail.x, track.right);
  expectWithin(
    midpointRail.y + midpointRail.height / 2,
    track.y + track.height / 2,
  );
  expect(upperResizeHitArea.bottom).toBeLessThanOrEqual(midpointRail.y);
  expect(lowerResizeHitArea.y).toBeGreaterThanOrEqual(midpointRail.bottom);
  expectWithin(geometry.content.x, track.right);
  expect(geometry.content.width).toBeGreaterThanOrEqual(
    PRODUCT_MAIN_CONTENT_MINIMUM,
  );
}

async function assertRailOnlyGeometry(
  page: Awaited<ReturnType<typeof launch>>["page"],
  width: number,
  height: number,
  collapsedPaneMounted = true,
  navigationVisible = true,
) {
  const geometry = await assertFramedWorkspace(
    page,
    width,
    height,
    navigationVisible,
  );
  expect(geometry.resizeHandle).toBeNull();
  if (collapsedPaneMounted) {
    expect(geometry.pane).not.toBeNull();
    expect(geometry.track?.width).toBe(0);
    expect(geometry.midpointRail?.x).toBe(geometry.content.x);
  } else {
    expect(geometry.track).toBeNull();
    expect(geometry.pane).toBeNull();
    expect(geometry.midpointRail).toBeNull();
  }
  expectWithin(geometry.content.x, geometry.frame.x + WORKSPACE_BORDER);
}

async function assertFramedWorkspace(
  page: Awaited<ReturnType<typeof launch>>["page"],
  width: number,
  height: number,
  navigationVisible = true,
) {
  const geometry = await shellGeometry(page);
  expectRect(geometry.wrapper, { x: 0, y: 0, width, height });
  const x = navigationVisible ? PRIMARY_RAIL_WIDTH : WORKSPACE_INSET;
  if (navigationVisible) {
    expectRect(geometry.rail!, {
      x: 0,
      y: 0,
      width: PRIMARY_RAIL_WIDTH,
      height,
    });
  } else {
    expect(geometry.rail).toBeNull();
  }
  expectRect(geometry.frame, {
    x,
    y: WORKSPACE_INSET,
    width: width - x - WORKSPACE_INSET,
    height: height - 2 * WORKSPACE_INSET,
  });
  expect(geometry.frameRadius).toBe("14px");
  expect(geometry.frameBorder).toBe("1px");
  expect(geometry.frameShadow).toBe("none");
  if (geometry.header) {
    expectRect(geometry.header, {
      x: x + WORKSPACE_BORDER,
      y: WORKSPACE_INSET + WORKSPACE_BORDER,
      width: geometry.frame.width - 2 * WORKSPACE_BORDER,
      height: 50,
    });
    expectWithin(geometry.header.bottom, geometry.body.y);
  }
  expectWithin(geometry.body.bottom, geometry.frame.bottom - WORKSPACE_BORDER);
  expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
  if (geometry.footer) {
    expectWithin(geometry.footer.y, geometry.content.bottom);
    expectWithin(geometry.footer.bottom, geometry.body.bottom);
  }
  return geometry;
}

async function assertFlatRows(
  page: Awaited<ReturnType<typeof launch>>["page"],
  label: string,
) {
  const list = page.getByRole("list", { name: label });
  await expect(list).toHaveAttribute("data-flat-row-list", "true");
  const rows = list.locator('[data-flat-row="true"]');
  expect(await rows.count()).toBeGreaterThan(1);
  const styles = await rows.evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return {
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        padding: style.padding,
        gap: style.gap,
      };
    }),
  );
  for (const style of styles) {
    expect(parseFloat(style.borderRadius) || 0).toBeLessThanOrEqual(1);
    expect(style.boxShadow).toBe("none");
    expect(style.padding).toBe("12px");
    expect(style.gap).toBe("10px");
  }
}

async function assertCaptureContainment(
  page: Awaited<ReturnType<typeof launch>>["page"],
  width: number,
  height: number,
  mustScroll: boolean,
) {
  const capture = page.getByRole("region", { name: "录制详情" });
  const footer = page.locator('[data-shell-slot="content-footer"]');
  await expect(footer).toBeVisible();
  const metrics = await capture.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const scrollContainer = element.closest<HTMLElement>("#main-content");
    const footer = document.querySelector<HTMLElement>(
      '[data-shell-slot="content-footer"]',
    );
    const footerRect = footer?.getBoundingClientRect();
    const footerStyle = footer ? getComputedStyle(footer) : null;
    return {
      rect: toPlainRect(rect),
      position: style.position,
      boxShadow: style.boxShadow,
      containerClientHeight: scrollContainer?.clientHeight ?? 0,
      containerScrollHeight: scrollContainer?.scrollHeight ?? 0,
      containerBottom: scrollContainer?.getBoundingClientRect().bottom ?? 0,
      footer: footerRect ? toPlainRect(footerRect) : null,
      footerBoxShadow: footerStyle?.boxShadow ?? null,
      footerFlexWrap: footerStyle?.flexWrap ?? null,
      footerClientWidth: footer?.clientWidth ?? 0,
      footerScrollWidth: footer?.scrollWidth ?? 0,
    };

    function toPlainRect(value: DOMRect) {
      return {
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
        right: value.right,
        bottom: value.bottom,
      };
    }
  });
  expect(metrics.rect.right).toBeLessThanOrEqual(width);
  expect(metrics.rect.x).toBeGreaterThanOrEqual(0);
  expect(metrics.rect.y).toBeGreaterThanOrEqual(0);
  expect(metrics.position).not.toBe("fixed");
  expect(metrics.boxShadow).toBe("none");
  if (!metrics.footer) throw new Error("Expected a capture footer");
  expectWithin(metrics.footer.y, metrics.containerBottom);
  expect(metrics.footer.right).toBeLessThanOrEqual(width);
  expect(metrics.footer.bottom).toBeLessThanOrEqual(height);
  expect(metrics.footerBoxShadow).toBe("none");
  expect(metrics.footerFlexWrap).toBe("nowrap");
  expect(metrics.footerScrollWidth).toBeLessThanOrEqual(
    metrics.footerClientWidth,
  );
  if (mustScroll) {
    expect(metrics.rect.width).toBeLessThanOrEqual(768);
    expect(metrics.containerScrollHeight).toBeGreaterThan(
      metrics.containerClientHeight,
    );
  } else {
    expect(metrics.rect.bottom).toBeLessThanOrEqual(height);
  }
}

async function assertAudioFirstUseGeometry(
  page: Awaited<ReturnType<typeof launch>>["page"],
) {
  const geometry = await audioFirstUseGeometry(page);
  expectRect(geometry.frame, geometry.main);
  expectMainPaddingRemoved(geometry.mainPadding);
  expectWithin(geometry.layout.width, Math.min(896, geometry.frame.width));
  expectWithin(geometry.content.width, geometry.layout.width / 2, 2);
  expect(geometry.preview.x).toBeGreaterThanOrEqual(geometry.content.right);
  expect(geometry.preview.x - geometry.content.right).toBeLessThanOrEqual(12);
  expectWithin(geometry.previewSurface.right, geometry.frame.right);
  expectWithin(geometry.previewSurface.bottom, geometry.frame.bottom);
  expect(geometry.previewSurfaceBorders.top).toBeGreaterThan(0);
  expect(geometry.previewSurfaceBorders.left).toBeGreaterThan(0);
  expectWithin(geometry.previewSurfaceBorders.right, 0);
  expectWithin(geometry.previewSurfaceBorders.bottom, 0);
  expectWithin(geometry.primaryAction.y, geometry.importAction.y);
  expect(geometry.documentScrollWidth).toBeLessThanOrEqual(
    geometry.documentClientWidth,
  );
  expect(geometry.mainScrollWidth).toBeLessThanOrEqual(
    geometry.mainClientWidth,
  );
  expect(geometry.actionGroupScrollWidth).toBeLessThanOrEqual(
    geometry.actionGroupClientWidth,
  );
  expect(geometry.primaryAction.right).toBeLessThanOrEqual(
    geometry.actionGroup.right + 1,
  );
  expect(geometry.importAction.right).toBeLessThanOrEqual(
    geometry.actionGroup.right + 1,
  );
  expect(geometry.previewFocusTargetCount).toBe(0);
}

async function audioFirstUseGeometry(
  page: Awaited<ReturnType<typeof launch>>["page"],
) {
  await expect(page.locator('[data-shell-slot="content-head"]')).toHaveCount(0);
  return await page.evaluate(() => {
    const main = required("#main-content");
    required('[data-audio-first-use="frame"]');
    const frame = required('[data-slot="full-screen-empty-state"]');
    const layout = required('[data-slot="full-screen-empty-state-layout"]');
    const content = required('[data-slot="full-screen-empty-state-content"]');
    const preview = required('[data-slot="full-screen-empty-state-preview"]');
    const previewSurface = required(
      '[data-slot="full-screen-empty-state-preview-surface"]',
    );
    const primaryAction = button("开始录制");
    const importAction = button("导入外部音频");
    const actionGroup = required(
      '[data-slot="full-screen-empty-state-actions"]',
    );
    const mainRect = main.getBoundingClientRect();
    const mainStyle = getComputedStyle(main);
    const previewRect = preview.getBoundingClientRect();
    const previewSurfaceStyle = getComputedStyle(previewSurface);

    return {
      main: rect(main),
      mainPadding: {
        top: parseFloat(mainStyle.paddingTop),
        right: parseFloat(mainStyle.paddingRight),
        bottom: parseFloat(mainStyle.paddingBottom),
        left: parseFloat(mainStyle.paddingLeft),
      },
      frame: rect(frame),
      layout: rect(layout),
      content: rect(content),
      preview: rect(preview),
      previewSurface: rect(previewSurface),
      previewSurfaceBorders: {
        top: parseFloat(previewSurfaceStyle.borderTopWidth),
        right: parseFloat(previewSurfaceStyle.borderRightWidth),
        bottom: parseFloat(previewSurfaceStyle.borderBottomWidth),
        left: parseFloat(previewSurfaceStyle.borderLeftWidth),
      },
      actionGroup: rect(actionGroup),
      primaryAction: rect(primaryAction),
      importAction: rect(importAction),
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      mainClientWidth: main.clientWidth,
      mainScrollWidth: main.scrollWidth,
      mainClientHeight: main.clientHeight,
      mainScrollHeight: main.scrollHeight,
      previewReachableBottom:
        previewRect.bottom - mainRect.top + main.scrollTop,
      actionGroupClientWidth: actionGroup.clientWidth,
      actionGroupScrollWidth: actionGroup.scrollWidth,
      previewFocusTargetCount: preview.querySelectorAll(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ).length,
    };

    function required(selector: string) {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element)
        throw new Error(`Missing audio first-use geometry target: ${selector}`);
      return element;
    }

    function button(name: string) {
      const element = Array.from(
        content.querySelectorAll<HTMLButtonElement>("button"),
      ).find((candidate) => candidate.textContent?.trim() === name);
      if (!element) throw new Error(`Missing audio first-use action: ${name}`);
      return element;
    }

    function rect(element: Element) {
      const value = element.getBoundingClientRect();
      return {
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
        right: value.right,
        bottom: value.bottom,
      };
    }
  });
}

function expectMainPaddingRemoved(padding: {
  top: number;
  right: number;
  bottom: number;
  left: number;
}) {
  expectWithin(padding.top, 0);
  expectWithin(padding.right, 0);
  expectWithin(padding.bottom, 0);
  expectWithin(padding.left, 0);
}

async function shellGeometry(page: Awaited<ReturnType<typeof launch>>["page"]) {
  return await page.evaluate(() => {
    const frame = required('[data-workspace-frame="true"]');
    const content = required("#main-content");
    const frameStyle = getComputedStyle(frame);
    const resizeHandle = document.querySelector(
      '[data-slot="pane-resize-handle"]',
    );

    return {
      wrapper: rect(required('[data-slot="sidebar-wrapper"]')),
      frame: rect(frame),
      frameRadius: frameStyle.borderRadius,
      frameBorder: frameStyle.borderLeftWidth,
      frameShadow: frameStyle.boxShadow,
      rail: findRect('[aria-label="工作站主导航"]'),
      header: findRect('[data-shell-slot="content-head"]'),
      body: rect(required('[data-shell-slot="workspace-body"]')),
      track: findRect('[data-shell-slot="context-pane-track"]'),
      pane: findRect('[data-slot="sidebar"][role="complementary"]'),
      resizeHandle: findRect('[data-slot="pane-resize-handle"]'),
      upperResizeHitArea: findRect('[data-pane-resize-hit-area="upper"]'),
      lowerResizeHitArea: findRect('[data-pane-resize-hit-area="lower"]'),
      midpointRail: findRect("[data-context-pane-midpoint-rail]"),
      resizeHandleValue: Number(resizeHandle?.getAttribute("aria-valuenow")),
      resizeHandleMinimum: Number(resizeHandle?.getAttribute("aria-valuemin")),
      resizeHandleMaximum: Number(resizeHandle?.getAttribute("aria-valuemax")),
      content: rect(content),
      footer: findRect('[data-shell-slot="content-footer"]'),
      horizontalOverflow: content.scrollWidth - content.clientWidth,
    };

    function required(selector: string) {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element)
        throw new Error(`Missing visual geometry target: ${selector}`);
      return element;
    }

    function findRect(selector: string) {
      const element = document.querySelector(selector);
      return element ? rect(element) : null;
    }

    function rect(element: Element) {
      const value = element.getBoundingClientRect();
      return {
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
        right: value.right,
        bottom: value.bottom,
      };
    }
  });
}

async function dragPaneDivider(
  page: Awaited<ReturnType<typeof launch>>["page"],
  area: "upper" | "lower",
  deltaX: number,
) {
  const hitArea = page.locator(`[data-pane-resize-hit-area="${area}"]`);
  const box = await hitArea.boundingBox();
  if (!box) throw new Error(`Expected the ${area} pane resize hit area`);
  const point = {
    x: box.x + box.width / 2,
    y: area === "upper" ? box.y + box.height - 2 : box.y + 2,
  };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + deltaX, point.y);
  await page.mouse.up();
}

async function resizeVisualWindow(
  session: Awaited<ReturnType<typeof launch>>,
  width: number,
  height: number,
) {
  await session.app.evaluate(
    ({ BrowserWindow, screen }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Visual BrowserWindow is unavailable");
      const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
      window.setContentSize(
        Math.round(size.width / scaleFactor),
        Math.round(size.height / scaleFactor),
      );
    },
    { width, height },
  );
  await expect
    .poll(() =>
      session.page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      })),
    )
    .toEqual({ width, height });
}

function expectRect(
  actual: { x: number; y: number; width: number; height: number },
  expected: { x: number; y: number; width: number; height: number },
) {
  expectWithin(actual.x, expected.x);
  expectWithin(actual.y, expected.y);
  expectWithin(actual.width, expected.width);
  expectWithin(actual.height, expected.height);
}

function sortEvidenceKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortEvidenceKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortEvidenceKeys(entry)]),
    );
  }
  return value;
}

function expectWithin(actual: number, expected: number, tolerance = 0.5) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

async function screenshot(
  session: Awaited<ReturnType<typeof launch>>,
  name: string,
  width: number,
  height: number,
) {
  const floatingBaseline = name === "floating-capture-recording.png";
  if (floatingBaseline && !canonicalScreenshots) {
    test.info().annotations.push({
      type: "screenshot-policy",
      description:
        "Canonical Renderer screenshots update only on macOS arm64; geometry still ran.",
    });
    return;
  }
  await session.page.mouse.move(width - 2, 2);
  await expect(session.page.getByRole("tooltip")).toHaveCount(0);
  await session.page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  const png = await session.app.evaluate(
    async ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Visual BrowserWindow is unavailable");
      const image = await window.webContents.capturePage();
      return image
        .resize({ width: size.width, height: size.height, quality: "best" })
        .toPNG()
        .toString("base64");
    },
    { width, height },
  );
  const body = Buffer.from(png, "base64");
  if (floatingBaseline) expect(body).toMatchSnapshot(name);
  else await test.info().attach(name, { body, contentType: "image/png" });
}
