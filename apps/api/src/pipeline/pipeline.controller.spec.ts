import { BadRequestException, ForbiddenException, ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ArgusRequest } from "../common/request";
import { PipelineController } from "./pipeline.controller";
import type { PipelineService } from "./pipeline.service";

describe("PipelineController evaluate endpoint", () => {
  const request = { identity: { id: "user-1", email: "user@example.test" } } as ArgusRequest;
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const monitorId = "22222222-2222-4222-8222-222222222222";
  const validKey = "33333333-3333-4333-8333-333333333333";

  it("delegates evaluate to pipeline service when params are valid", async () => {
    const mockExecution = {
      id: "exec-1",
      organizationId,
      monitorId,
      monitorVersion: 2,
      kind: "EVALUATION" as const,
      status: "QUEUED" as const,
      scheduledAt: new Date().toISOString(),
      deadlineAt: new Date().toISOString(),
      completedAt: null,
      observation: null,
    };
    const evaluate = vi.fn().mockResolvedValue(mockExecution);
    const controller = new PipelineController({ evaluate } as unknown as PipelineService);

    const result = await controller.evaluate(request, organizationId, monitorId, validKey, { monitorVersion: 2 });
    expect(result).toEqual(mockExecution);
    expect(evaluate).toHaveBeenCalledWith(organizationId, "user-1", monitorId, validKey, 2);
  });

  it.each([undefined, "", "not-a-uuid", "12345"])("rejects invalid or missing Idempotency-Key %s", (key) => {
    const controller = new PipelineController({ evaluate: vi.fn() } as unknown as PipelineService);
    expect(() => controller.evaluate(request, organizationId, monitorId, key, { monitorVersion: 1 })).toThrow(BadRequestException);
  });

  it.each([undefined, 0, -1, 1.5, "2", null])("rejects invalid monitorVersion %s", (version) => {
    const controller = new PipelineController({ evaluate: vi.fn() } as unknown as PipelineService);
    expect(() => controller.evaluate(request, organizationId, monitorId, validKey, { monitorVersion: version as any })).toThrow(BadRequestException);
  });
});
