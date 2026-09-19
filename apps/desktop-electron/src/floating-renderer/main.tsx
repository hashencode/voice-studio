import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initializeAppearanceTheme } from "../renderer/features/settings/appearance-theme";
import { AppearanceThemeProvider } from "../renderer/features/settings/appearance-theme-provider";
import { FloatingCaptureApp } from "./floating-capture-app";
import "./floating.css";

initializeAppearanceTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppearanceThemeProvider>
      <FloatingCaptureApp />
    </AppearanceThemeProvider>
  </StrictMode>,
);
