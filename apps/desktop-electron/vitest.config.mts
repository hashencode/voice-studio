import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src/renderer"),
    },
  },
  test: {
    include: ["tests/**/*_test.{ts,tsx}"],
    setupFiles: ["./tests/test_setup.ts"],
  },
});
