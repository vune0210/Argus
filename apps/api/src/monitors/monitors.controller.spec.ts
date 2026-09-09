import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ArgusRequest } from "../common/request";
import { MonitorsController } from "./monitors.controller";
import type { MonitorsService } from "./monitors.service";

describe("MonitorsController pagination", () => {
  const request = { identity: { id: "user-1", email: "user@example.test" } } as ArgusRequest;
  const organizationId = "11111111-1111-4111-8111-111111111111";

  it("uses the default page size", async () => {
    const list = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const controller = new MonitorsController({ list } as unknown as MonitorsService);

    await expect(controller.list(request, organizationId)).resolves.toEqual({ items: [], nextCursor: null });
    expect(list).toHaveBeenCalledWith(organizationId, "user-1", 50, undefined);
  });

  it.each(["0", "101", "1.5", "not-a-number"])("rejects invalid limit %s", (limit) => {
    const controller = new MonitorsController({ list: vi.fn() } as unknown as MonitorsService);
    expect(() => controller.list(request, organizationId, limit)).toThrow(BadRequestException);
  });

  describe("timeseries endpoint", () => {
    const monitorId = "22222222-2222-4222-8222-222222222222";

    it("defaults window to 24h and delegates to service", async () => {
      const getTimeseries = vi.fn().mockResolvedValue({ monitorId, from: "", to: "", truncated: false, series: {} });
      const controller = new MonitorsController({ getTimeseries } as unknown as MonitorsService);

      await controller.timeseries(request, organizationId, monitorId, undefined);
      expect(getTimeseries).toHaveBeenCalledWith(organizationId, "user-1", monitorId, "24h");
    });

    it.each(["1h", "6h", "24h"])("accepts valid window %s", async (window) => {
      const getTimeseries = vi.fn().mockResolvedValue({ monitorId, from: "", to: "", truncated: false, series: {} });
      const controller = new MonitorsController({ getTimeseries } as unknown as MonitorsService);

      await controller.timeseries(request, organizationId, monitorId, window);
      expect(getTimeseries).toHaveBeenCalledWith(organizationId, "user-1", monitorId, window);
    });

    it.each(["12h", "7d", "invalid"])("rejects invalid window %s", (window) => {
      const controller = new MonitorsController({ getTimeseries: vi.fn() } as unknown as MonitorsService);
      expect(() => controller.timeseries(request, organizationId, monitorId, window)).toThrow(BadRequestException);
    });
  });
});
