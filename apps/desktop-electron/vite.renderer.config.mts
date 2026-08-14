import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const directory = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(directory, "src/renderer");

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  // Electron keeps script-src locked to same-origin scripts. React Fast Refresh
  // injects an inline preamble in development, so use full renderer reloads
  // instead of weakening the production-equivalent CSP.
  server: {
    hmr: false,
  },
  resolve: {
    alias: {
      "@": rendererRoot,
      "@shared": path.resolve(directory, "src/shared"),
    },
  },
  build: {
    rollupOptions: {
      input: path.resolve(directory, "index.html"),
    },
  },
});
