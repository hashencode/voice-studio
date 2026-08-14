import { defineConfig } from "vite";

export const externalMainDependencies = ["electron", /^node:/] as const;

export default defineConfig({
  build: {
    rollupOptions: {
      external: [...externalMainDependencies],
    },
  },
});
