/// <reference types="vite/client" />

import type { Voice2TextFloatingApi } from "../shared/contracts";

declare global {
  interface Window {
    voice2textFloating: Voice2TextFloatingApi;
  }
}

export {};
