import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  cacheDir: path.resolve(
    directory,
    "node_modules/.vite/floating_capture_window",
  ),
  plugins: [react(), tailwindcss()],
  server: { hmr: false },
  resolve: {
    alias: {
      "@": path.resolve(directory, "src/renderer"),
      "@shared": path.resolve(directory, "src/shared"),
    },
  },
  build: {
    rollupOptions: { input: path.resolve(directory, "floating.html") },
  },
});
