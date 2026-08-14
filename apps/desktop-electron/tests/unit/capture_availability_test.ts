import { describe, expect, it, vi } from "vitest";

import { listAvailableCaptureRecoveries } from "../../src/main/domain/capture/capture_availability";
import type { DesktopCaptureService } from "../../src/main/domain/capture/desktop_capture_service";

describe("capture availability", () => {
  it("fails closed while the signed helper-backed service is unavailable", () => {
    expect(() => listAvailableCaptureRecoveries(null)).toThrow(
      /capture recovery is unavailable/,
    );
  });

  it("returns the durable repository view only through an initialized service", () => {
    const listRecoveries = vi.fn(() => []);
    const service = { listRecoveries } as unknown as DesktopCaptureService;
    expect(listAvailableCaptureRecoveries(service)).toEqual([]);
    expect(listRecoveries).toHaveBeenCalledOnce();
  });
});
