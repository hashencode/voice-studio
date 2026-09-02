import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { resetSectionRoutersForTests } from "../src/renderer/features/shell/section-router-registry";

afterEach(async () => {
  if (typeof document !== "undefined") cleanup();
  await resetSectionRoutersForTests();
  if (typeof window !== "undefined") {
    window.localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
      writable: true,
    });
  }
});

if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: mediaQueryMatches(query, window.innerWidth),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

function mediaQueryMatches(query: string, width: number): boolean {
  const maxWidth = query.match(/max-width:\s*(\d+)px/);
  if (maxWidth) return width <= Number(maxWidth[1]);
  const minWidth = query.match(/min-width:\s*(\d+)px/);
  if (minWidth) return width >= Number(minWidth[1]);
  return false;
}

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
}
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: TestResizeObserver,
});

if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.hasPointerCapture ??= () => false;
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
  HTMLElement.prototype.releasePointerCapture ??= () => undefined;
  HTMLElement.prototype.scrollIntoView ??= () => undefined;
}
