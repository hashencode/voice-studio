export const APPEARANCE_MODE_STORAGE_KEY = "voice2text.appearance-mode.v1";
export const SYSTEM_DARK_MODE_QUERY = "(prefers-color-scheme: dark)";

export type AppearanceMode = "system" | "dark" | "light";

export function readStoredAppearanceMode(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): AppearanceMode {
  try {
    const stored = storage.getItem(APPEARANCE_MODE_STORAGE_KEY);
    return isAppearanceMode(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyAppearanceMode(
  mode: AppearanceMode,
  root: HTMLElement = document.documentElement,
  systemPrefersDark = window.matchMedia(SYSTEM_DARK_MODE_QUERY).matches,
) {
  const dark = mode === "dark" || (mode === "system" && systemPrefersDark);
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
}

export function initializeAppearanceTheme() {
  applyAppearanceMode(readStoredAppearanceMode());
}

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === "system" || value === "dark" || value === "light";
}
