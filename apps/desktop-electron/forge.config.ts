import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: "com.voice2text.desktop",
    appCategoryType: "public.app-category.productivity",
    asar: true,
    executableName: "Voice2Text",
    extendInfo: {
      NSMicrophoneUsageDescription:
        "Voice2Text uses the selected microphone for meetings you explicitly record.",
      NSAudioCaptureUsageDescription:
        "Voice2Text captures system audio only while you explicitly record a meeting.",
    },
    extraResource: [
      path.resolve("resources/worker"),
      path.resolve("resources/native"),
      path.resolve("resources/playback"),
    ],
  },
  hooks: {
    postPackage: async (_forgeConfig, result) => {
      if (result.platform !== "darwin") return;
      for (const outputPath of result.outputPaths) {
        const appPath = outputPath.endsWith(".app")
          ? outputPath
          : path.join(outputPath, "Voice2Text.app");
        if (!existsSync(appPath)) {
          throw new Error("unexpected macOS package output");
        }
        execFileSync("/usr/bin/codesign", [
          "--force",
          "--deep",
          "--sign",
          "-",
          appPath,
        ]);
      }
    },
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ["darwin"])],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
      concurrent: false,
    }),
  ],
};

export default config;
