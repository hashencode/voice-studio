export const macOSArm64ResourceTarget = "darwin-arm64";

export function assertMacOSArm64ResourceHost(
  platform = process.platform,
  architecture = process.arch,
): typeof macOSArm64ResourceTarget {
  if (platform !== "darwin" || architecture !== "arm64") {
    throw new Error(
      `worker resources require the ${macOSArm64ResourceTarget} host target; received ${platform}-${architecture}`,
    );
  }
  return macOSArm64ResourceTarget;
}
