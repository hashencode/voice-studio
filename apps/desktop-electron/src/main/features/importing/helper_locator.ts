import path from "node:path";

import type { ResourceRootInput } from "../../resources/resource_catalog";

export function resolveMacOSNativeHelper(input: ResourceRootInput): string {
  return input.packaged
    ? path.join(
        path.resolve(input.resourcesPath),
        "native",
        "macos",
        "bin",
        "desktop_macos_native_helper",
      )
    : path.resolve(
        input.appRoot,
        "../../packages/desktop_macos_native/.build/debug/desktop_macos_native_helper",
      );
}
