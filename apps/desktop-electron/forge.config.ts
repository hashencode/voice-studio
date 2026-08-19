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
    ignore: [/^\/tests\/visual(?:\/|$)/],
    executableName: "Voice2Text",
    extendInfo: {
      NSMicrophoneUsageDescription:
        "Voice2Text uses the selected microphone for audios you explicitly record.",
      NSAudioCaptureUsageDescription:
        "Voice2Text captures system audio only while you explicitly record a audio.",
      NSLocalNetworkUsageDescription:
        "Voice2Text discovers your paired phone on the local network only when you enable companion transfer.",
      NSBonjourServices: ["_voice2text-audio._tcp"],
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
        const helperPath = path.join(
          appPath,
          "Contents/Resources/native/macos/bin/desktop_macos_native_helper",
        );
        const signingIdentity =
          process.env.VOICE2TEXT_MACOS_SIGN_IDENTITY ?? "-";
        execFileSync("/usr/bin/codesign", [
          "--force",
          "--deep",
          "--sign",
          signingIdentity,
          appPath,
        ]);
        const helperSignArguments = ["--force", "--sign", signingIdentity];
        if (signingIdentity === "-") {
          helperSignArguments.push("--timestamp=none");
        } else {
          helperSignArguments.push(
            "--entitlements",
            path.resolve(
              "native/macos/desktop-macos-native-helper.entitlements",
            ),
          );
        }
        helperSignArguments.push(helperPath);
        execFileSync("/usr/bin/codesign", helperSignArguments);
        execFileSync("/usr/bin/codesign", [
          "--force",
          "--sign",
          signingIdentity,
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
