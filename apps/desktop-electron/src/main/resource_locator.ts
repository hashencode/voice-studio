import path from "node:path";

export { resolveResourceRoot } from "./resources/resource_catalog";

export interface ResourceLocatorInput {
  appRoot: string;
  packaged: boolean;
  resourcesPath: string;
}

export interface WorkerResources {
  root: string;
  manifestPath: string;
  runtimeRoot: string;
  workerPath: string;
}

export function resolveWorkerResources(
  input: ResourceLocatorInput,
): WorkerResources {
  const root = input.packaged
    ? path.join(input.resourcesPath, "worker")
    : path.join(input.appRoot, "resources", "worker");

  return {
    root,
    manifestPath: path.join(root, "manifest.json"),
    runtimeRoot: path.join(root, "runtime"),
    workerPath: path.join(root, "bin", "desktop_sherpa_worker"),
  };
}
