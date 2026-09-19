// @vitest-environment jsdom

import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppearanceSettingsFeature } from "../../../src/renderer/features/settings/appearance-settings-feature";
import {
  APPEARANCE_MODE_STORAGE_KEY,
  applyAppearanceMode,
  initializeAppearanceTheme,
  readStoredAppearanceMode,
} from "../../../src/renderer/features/settings/appearance-theme";
import { AppearanceThemeProvider } from "../../../src/renderer/features/settings/appearance-theme-provider";

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  vi.restoreAllMocks();
});

describe("appearance theme", () => {
  it("defaults invalid or missing preferences to following the system", () => {
    expect(readStoredAppearanceMode({ getItem: () => null })).toBe("system");
    expect(readStoredAppearanceMode({ getItem: () => "sepia" })).toBe("system");
  });

  it("applies the stored mode before the React application renders", () => {
    window.localStorage.setItem(APPEARANCE_MODE_STORAGE_KEY, "dark");

    initializeAppearanceTheme();

    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("resolves the system mode from the current platform preference", () => {
    applyAppearanceMode("system", document.documentElement, true);
    expect(document.documentElement).toHaveClass("dark");

    applyAppearanceMode("system", document.documentElement, false);
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("tracks platform changes while following the system", () => {
    let onChange: ((event: MediaQueryListEvent) => void) | undefined;
    vi.spyOn(window, "matchMedia").mockImplementation(
      () =>
        ({
          matches: false,
          addEventListener: (
            type: string,
            listener: (event: MediaQueryListEvent) => void,
          ) => {
            if (type === "change") onChange = listener;
          },
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );

    render(
      <AppearanceThemeProvider>
        <div />
      </AppearanceThemeProvider>,
    );
    expect(document.documentElement).not.toHaveClass("dark");

    onChange?.({ matches: true } as MediaQueryListEvent);
    expect(document.documentElement).toHaveClass("dark");
  });

  it("updates and persists the color mode from general settings", async () => {
    const user = userEvent.setup();
    render(
      <AppearanceThemeProvider>
        <AppearanceSettingsFeature />
      </AppearanceThemeProvider>,
    );

    await user.click(screen.getByRole("combobox", { name: "色彩模式" }));
    await user.click(await screen.findByRole("option", { name: "深色" }));

    expect(document.documentElement).toHaveClass("dark");
    expect(window.localStorage.getItem(APPEARANCE_MODE_STORAGE_KEY)).toBe(
      "dark",
    );
    expect(
      screen.getByRole("combobox", { name: "色彩模式" }),
    ).toHaveTextContent("深色");
  });
});
