export interface CaptureResourceCatalog {
  command(operationId: string): unknown;
}

export function hasVerifiedLiveCaptionCapability(
  catalog: CaptureResourceCatalog | null,
): boolean {
  if (!catalog) return false;
  try {
    catalog.command("live-caption");
    return true;
  } catch {
    return false;
  }
}

export function capturePreflightAllowsStart(
  preflight: { canStart: boolean; captionModelAvailable: boolean },
  captionEnabled: boolean,
): boolean {
  return (
    preflight.canStart && (!captionEnabled || preflight.captionModelAvailable)
  );
}
