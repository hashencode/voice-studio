export interface CaptureResourceCatalog {
  processingIdentity(operationId: string): unknown | null;
}

export function hasVerifiedLiveCaptionCapability(
  catalog: CaptureResourceCatalog | null,
): boolean {
  if (!catalog) return false;
  try {
    return catalog.processingIdentity("live-caption") !== null;
  } catch {
    return false;
  }
}

export function capturePreflightAllowsStart(
  preflight: { canStart: boolean; captionModelAvailable: boolean },
  _captionEnabled: boolean,
): boolean {
  void _captionEnabled;
  return preflight.canStart;
}
