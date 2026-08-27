import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";
import electronExecutable from "electron";

import {
  buildVisualFixture,
  type VisualScenario,
  VISUAL_NOW_MS,
} from "./fixtures/renderer-api";

const harnessMain = path.resolve("tests/visual/.harness-build/main.js");
const harnessPreload = path.resolve("tests/visual/.harness-build/preload.js");
const rendererUrl = "http://127.0.0.1:4179";
const expectedFontStack =
  '-apple-system, "system-ui", "SF Pro Text", "PingFang SC", sans-serif';
const canonicalScreenshots =
  process.platform === "darwin" && process.arch === "arm64";

test.describe("sidebar-09 production Renderer", () => {
  test("1240x820 Audio open, selected, active capture", async () => {
    await withVisualSession("audio-active", 1240, 820, async (session) => {
      const { page } = session;
      await expect(
        page.getByRole("heading", { name: "录制详情", level: 1 }),
      ).toBeVisible();
      await expect(
        page.getByRole("complementary", { name: "录制控制" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "录制详情" }),
      ).toContainText("正在录制");

      const headerHeights = await page.evaluate(() => ({
        pane: document
          .querySelector<HTMLElement>("[data-context-pane-fixed-header]")!
          .getBoundingClientRect().height,
        content: document
          .querySelector<HTMLElement>('[data-slot="sidebar-inset"] > header')!
          .getBoundingClientRect().height,
      }));
      expect(headerHeights.pane).toBeGreaterThan(58);
      expectWithin(headerHeights.content, 58);

      await assertRuntimeContract(page, 1240, 820);
      await assertDockedGeometry(page, 1240, 820);
      await assertFlatRows(page, "音频列表");
      await assertCaptureContainment(page, 1240, 820, false);
      await screenshot(
        session,
        "audio-open-selected-active-capture.png",
        1240,
        820,
      );
    });
  });

  test("1240x820 Audio pane closed", async () => {
    await withVisualSession("audio-closed", 1240, 820, async (session) => {
      const { page } = session;
      await expect(
        page.getByRole("region", { name: "录制准备" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "请选择音频", level: 1 }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: "收起音频上下文面板" }).click();
      await expect(
        page.getByRole("complementary", { name: "音频上下文面板" }),
      ).toBeHidden();
      await expect(
        page.getByRole("button", { name: "打开音频上下文面板" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "请选择音频", level: 1 }),
      ).toHaveCount(0);

      await assertRuntimeContract(page, 1240, 820);
      await assertRailOnlyGeometry(page, 1240, 820);
      await screenshot(session, "audio-pane-closed.png", 1240, 820);
    });
  });

  test("1240x820 Empty audio library and recording ready", async () => {
    await withVisualSession("audio-empty", 1240, 820, async (session) => {
      const { page } = session;
      await expect(
        page.getByRole("status", { name: "还没有音频" }),
      ).toBeVisible();
      await expect(
        page.getByRole("region", { name: "录制准备" }),
      ).toBeVisible();

      const layout = await page.evaluate(() => {
        const paneHeader = document.querySelector<HTMLElement>(
          "[data-context-pane-fixed-header]",
        )!;
        const paneContent = document.querySelector<HTMLElement>(
          "[data-context-pane-scrolling-content]",
        )!;
        const empty = document.querySelector<HTMLElement>(
          '[role="status"][aria-label="还没有音频"]',
        )!;
        const paneContentRect = paneContent.getBoundingClientRect();
        const emptyRect = empty.getBoundingClientRect();
        return {
          paneHeaderHeight: paneHeader.getBoundingClientRect().height,
          emptyCenterRatio:
            (emptyRect.y + emptyRect.height / 2 - paneContentRect.y) /
            paneContentRect.height,
        };
      });
      expect(layout.paneHeaderHeight).toBeGreaterThan(58);
      expect(layout.emptyCenterRatio).toBeGreaterThan(0.46);
      expect(layout.emptyCenterRatio).toBeLessThan(0.54);

      await assertRuntimeContract(page, 1240, 820);
      await assertDockedGeometry(page, 1240, 820);
      await screenshot(session, "audio-empty-recording-ready.png", 1240, 820);
    });
  });

  test("1240x820 Settings", async () => {
    await withVisualSession("settings", 1240, 820, async (session) => {
      const { page } = session;
      await expect(
        page.getByRole("heading", { name: "通用", level: 2 }),
      ).toBeVisible();
      await assertRuntimeContract(page, 1240, 820);
      await assertDockedGeometry(page, 1240, 820);
      await screenshot(session, "settings.png", 1240, 820);
    });
  });

  test("1240x820 Activity messages with detail", async () => {
    await withVisualSession("activity-messages", 1240, 820, async (session) => {
      const { page } = session;
      await page.getByRole("button", { name: "消息，2 条未读" }).click();
      await page
        .getByRole("button", { name: /产品设计评审录制不完整/ })
        .click();
      await expect(
        page.getByRole("region", { name: "消息详情" }),
      ).toContainText("只保存了部分音频");

      await assertRuntimeContract(page, 1240, 820);
      await assertDockedGeometry(page, 1240, 820);
      await screenshot(session, "activity-messages.png", 1240, 820);
    });
  });

  test("880x620 docked Audio with capture recovery and internal scroll", async () => {
    await withVisualSession("audio-recovery", 880, 620, async (session) => {
      const { page } = session;
      await expect(
        page.getByRole("heading", { name: "录制详情", level: 1 }),
      ).toBeVisible();
      await expect(
        page.getByRole("complementary", { name: "录制控制" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "发现可恢复录制" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "管理恢复录制" }).first().click();

      await assertRuntimeContract(page, 880, 620);
      await assertDockedGeometry(page, 880, 620);
      await assertFlatRows(page, "音频列表");
      await assertCaptureContainment(page, 880, 620, true);
      await screenshot(session, "audio-overlay-capture-recovery.png", 880, 620);
    });
  });

  test("320x620 keeps the fixed docked pane controls reachable", async () => {
    await withVisualSession("audio-active", 320, 620, async (session) => {
      const { page } = session;
      const collapse = page.getByRole("button", {
        name: "收起音频上下文面板",
      });

      await expect(collapse).toBeVisible();
      await assertRuntimeContract(page, 320, 620);
      await assertDockedGeometry(page, 320, 620);

      const collapseBounds = await collapse.boundingBox();
      expect(collapseBounds).not.toBeNull();
      expect(collapseBounds!.x).toBeGreaterThanOrEqual(0);
      expect(collapseBounds!.x + collapseBounds!.width).toBeLessThanOrEqual(
        320,
      );
    });
  });

  test("1240x820 Companion with multiple devices", async () => {
    await withVisualSession("companion-devices", 1240, 820, async (session) => {
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

      await assertRuntimeContract(page, 1240, 820);
      await assertDockedGeometry(page, 1240, 820);
      await assertFlatRows(page, "已信任设备列表");
      await screenshot(session, "companion-multiple-devices.png", 1240, 820);
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
    return { app, page };
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
    fontFamily: getComputedStyle(document.body).fontFamily,
    frozenNow: Date.now(),
  }));
  expect(runtime).toEqual({
    width,
    height,
    dpr: 1,
    language: "zh-CN",
    colorScheme: "light",
    reducedMotion: true,
    fontFamily: expectedFontStack,
    frozenNow: Date.UTC(2026, 7, 19, 3, 20, 0),
  });
}

async function assertDockedGeometry(
  page: Awaited<ReturnType<typeof launch>>["page"],
  width: number,
  height: number,
) {
  const geometry = await shellGeometry(page);
  expectRect(geometry.wrapper, { x: 0, y: 0, width, height });
  expectHorizontalRect(geometry.gap, { x: 0, width: 48 });
  expectRect(geometry.container, { x: 0, y: 0, width: 350, height });
  expectRect(geometry.rail, { x: 0, y: 0, width: 49, height });
  expectWithin(geometry.railContentWidth, 48);
  expectWithin(geometry.railBorderRight, 1);
  if (!geometry.pane) throw new Error("Expected a docked context pane");
  expectRect(geometry.pane, { x: 49, y: 0, width: 301, height });
  expectWithin(geometry.inset.x, 350);
  expectWithin(geometry.inset.width, Math.max(0, width - 350));
}

async function assertRailOnlyGeometry(
  page: Awaited<ReturnType<typeof launch>>["page"],
  width: number,
  height: number,
) {
  await expect
    .poll(async () => {
      const geometry = await shellGeometry(page);
      return Math.abs(geometry.gap.width - 48);
    })
    .toBeLessThanOrEqual(1);
  const geometry = await shellGeometry(page);
  expectRect(geometry.wrapper, { x: 0, y: 0, width, height });
  expectHorizontalRect(geometry.gap, { x: 0, width: 48 });
  expectRect(geometry.container, { x: 0, y: 0, width: 48, height });
  expectRect(geometry.rail, { x: 0, y: 0, width: 49, height });
  expectWithin(geometry.railContentWidth, 48);
  expectWithin(geometry.railBorderRight, 1);
  if (!geometry.pane)
    throw new Error("Expected the collapsed pane to remain mounted");
  expectRect(geometry.pane, { x: 49, y: 0, width: 0, height });
  expectWithin(geometry.inset.x, 48);
  expectWithin(geometry.inset.width, width - 48);
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
      };
    }),
  );
  for (const style of styles) {
    expect(parseFloat(style.borderRadius) || 0).toBeLessThanOrEqual(1);
    expect(style.boxShadow).toBe("none");
  }
}

async function assertCaptureContainment(
  page: Awaited<ReturnType<typeof launch>>["page"],
  width: number,
  height: number,
  mustScroll: boolean,
) {
  const capture = page.getByRole("region", { name: "录制详情" });
  const metrics = await capture.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const scrollContainer = element.closest<HTMLElement>("#main-content");
    return {
      rect: toPlainRect(rect),
      position: style.position,
      boxShadow: style.boxShadow,
      containerClientHeight: scrollContainer?.clientHeight ?? 0,
      containerScrollHeight: scrollContainer?.scrollHeight ?? 0,
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
  if (mustScroll) {
    expect(metrics.rect.width).toBeLessThanOrEqual(768);
    expect(metrics.containerScrollHeight).toBeGreaterThan(
      metrics.containerClientHeight,
    );
  } else {
    expect(metrics.rect.bottom).toBeLessThanOrEqual(height);
    expect(metrics.rect.height).toBeGreaterThan(0);
  }
}

async function shellGeometry(page: Awaited<ReturnType<typeof launch>>["page"]) {
  return await page.evaluate(() => {
    const wrapper = required('[data-slot="sidebar-wrapper"]');
    const outer = required(':scope > [data-slot="sidebar"]', wrapper);
    const gap = required(':scope > [data-slot="sidebar-gap"]', outer);
    const container = required(
      ':scope > [data-slot="sidebar-container"]',
      outer,
    );
    const inner = required(':scope > [data-slot="sidebar-inner"]', container);
    const nested = Array.from(
      inner.querySelectorAll<HTMLElement>(':scope > [data-slot="sidebar"]'),
    );
    const rail = nested[0]!;
    const pane = nested[1] ?? null;
    const inset = required(':scope > [data-slot="sidebar-inset"]', wrapper);
    const railStyle = getComputedStyle(rail);
    return {
      wrapper: rect(wrapper),
      gap: rect(gap),
      container: rect(container),
      rail: rect(rail),
      pane: pane ? rect(pane) : null,
      inset: rect(inset),
      railContentWidth:
        rail.getBoundingClientRect().width -
        parseFloat(railStyle.borderRightWidth),
      railBorderRight: parseFloat(railStyle.borderRightWidth),
    };

    function required(selector: string, root: ParentNode = document) {
      const element = root.querySelector<HTMLElement>(selector);
      if (!element)
        throw new Error(`Missing visual geometry target: ${selector}`);
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

function expectRect(
  actual: { x: number; y: number; width: number; height: number },
  expected: { x: number; y: number; width: number; height: number },
) {
  expectWithin(actual.x, expected.x);
  expectWithin(actual.y, expected.y);
  expectWithin(actual.width, expected.width);
  expectWithin(actual.height, expected.height);
}

function expectHorizontalRect(
  actual: { x: number; width: number },
  expected: { x: number; width: number },
) {
  expectWithin(actual.x, expected.x);
  expectWithin(actual.width, expected.width);
}

function expectWithin(actual: number, expected: number, tolerance = 1) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

async function screenshot(
  session: Awaited<ReturnType<typeof launch>>,
  name: string,
  width: number,
  height: number,
) {
  if (!canonicalScreenshots) {
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
  expect(Buffer.from(png, "base64")).toMatchSnapshot(name);
}
