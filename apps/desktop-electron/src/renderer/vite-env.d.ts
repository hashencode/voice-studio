/// <reference types="vite/client" />

import type { Voice2TextDesktopApi } from "../shared/contracts";

declare global {
  interface Window {
    voice2text: Voice2TextDesktopApi;
  }
}

export {};
