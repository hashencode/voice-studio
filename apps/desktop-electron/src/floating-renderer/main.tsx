import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { FloatingCaptureApp } from "./floating-capture-app";
import "./floating.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FloatingCaptureApp />
  </StrictMode>,
);
