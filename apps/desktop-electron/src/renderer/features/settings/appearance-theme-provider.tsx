import * as React from "react";

import {
  APPEARANCE_MODE_STORAGE_KEY,
  type AppearanceMode,
  applyAppearanceMode,
  isAppearanceMode,
  readStoredAppearanceMode,
  SYSTEM_DARK_MODE_QUERY,
} from "@/features/settings/appearance-theme";

type AppearanceThemeContextValue = {
  mode: AppearanceMode;
  setMode: (mode: AppearanceMode) => void;
};

const AppearanceThemeContext =
  React.createContext<AppearanceThemeContextValue | null>(null);

export function AppearanceThemeProvider({ children }: React.PropsWithChildren) {
  const [mode, setModeState] = React.useState<AppearanceMode>(() =>
    readStoredAppearanceMode(),
  );

  const setMode = React.useCallback((nextMode: AppearanceMode) => {
    try {
      window.localStorage.setItem(APPEARANCE_MODE_STORAGE_KEY, nextMode);
    } catch {
      // Keep the selected theme for this session when persistence is unavailable.
    }
    applyAppearanceMode(nextMode);
    setModeState(nextMode);
  }, []);

  React.useLayoutEffect(() => {
    applyAppearanceMode(mode);
    if (mode !== "system") return;

    const mediaQuery = window.matchMedia(SYSTEM_DARK_MODE_QUERY);
    const handleSystemThemeChange = (event: MediaQueryListEvent) => {
      applyAppearanceMode("system", document.documentElement, event.matches);
    };
    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => {
      mediaQuery.removeEventListener("change", handleSystemThemeChange);
    };
  }, [mode]);

  React.useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key !== APPEARANCE_MODE_STORAGE_KEY && event.key !== null)
        return;
      const nextMode = isAppearanceMode(event.newValue)
        ? event.newValue
        : "system";
      applyAppearanceMode(nextMode);
      setModeState(nextMode);
    };
    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  const value = React.useMemo(() => ({ mode, setMode }), [mode, setMode]);
  return (
    <AppearanceThemeContext.Provider value={value}>
      {children}
    </AppearanceThemeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAppearanceTheme(): AppearanceThemeContextValue {
  const value = React.useContext(AppearanceThemeContext);
  if (!value) {
    throw new Error("useAppearanceTheme must be used within a provider");
  }
  return value;
}
