import path from "node:path";

export interface ResourceLocatorInput {
  appRoot: string;
  packaged: boolean;
  resourcesPath: string;
}

export interface WorkerResources {
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
    runtimeRoot: path.join(root, "runtime"),
    workerPath: path.join(root, "bin", "desktop_sherpa_worker"),
  };
}
