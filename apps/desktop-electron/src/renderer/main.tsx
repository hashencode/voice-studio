import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { initializeAppearanceTheme } from "./features/settings/appearance-theme";
import "./index.css";

initializeAppearanceTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
