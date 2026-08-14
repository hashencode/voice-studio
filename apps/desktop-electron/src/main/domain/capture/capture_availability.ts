import type { DesktopCaptureService } from "./desktop_capture_service";

export function listAvailableCaptureRecoveries(
  service: DesktopCaptureService | null,
) {
  if (!service) throw new Error("capture recovery is unavailable");
  return service.listRecoveries();
}
