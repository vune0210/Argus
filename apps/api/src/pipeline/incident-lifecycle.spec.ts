import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PipelineService } from "./pipeline.service";
import { PipelineController } from "./pipeline.controller";
import type { OrganizationsService } from "../organizations/organizations.service";
import type { RedisStreams } from "./redis-streams";
import type { ArgusRequest } from "../common/request";

describe("Incident Lifecycle Unit Tests", () => {
  const orgId = "11111111-1111-4111-8111-111111111111";
  const userId = "user-responder-1";
  const incidentId = "22222222-2222-4222-8222-222222222222";
  const monitorId = "33333333-3333-4333-8333-333333333333";

  let mockPool: Partial<Pool>;
  let mockClient: Partial<PoolClient>;
  let mockOrgs: Partial<OrganizationsService>;
  let mockStreams: Partial<RedisStreams>;
  let service: PipelineService;
  let controller: PipelineController;

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    };

    mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient as PoolClient),
      query: vi.fn(),
    };

    mockOrgs = {
      membership: vi.fn().mockResolvedValue("RESPONDER"),
      requireIncidentWrite: vi.fn().mockResolvedValue("RESPONDER"),
      requireMonitorWrite: vi.fn().mockResolvedValue("OWNER"),
    };

    mockStreams = {
      publish: vi.fn().mockResolvedValue("1-0"),
    };

    service = new PipelineService(
      mockPool as Pool,
      mockOrgs as OrganizationsService,
      mockStreams as RedisStreams,
    );

    controller = new PipelineController(service);
  });

  describe("RBAC verification", () => {
    it("rejects VIEWER from acknowledging incidents", async () => {
      mockOrgs.requireIncidentWrite = vi.fn().mockRejectedValue(
        new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Responder, Admin, or Owner role is required" }),
      );

      await expect(service.ackIncident(orgId, "viewer-user", incidentId)).rejects.toThrow(ForbiddenException);
    });

    it("rejects VIEWER from resolving incidents", async () => {
      mockOrgs.requireIncidentWrite = vi.fn().mockRejectedValue(
        new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Responder, Admin, or Owner role is required" }),
      );

      await expect(service.resolveIncident(orgId, "viewer-user", incidentId)).rejects.toThrow(ForbiddenException);
    });

    it("allows RESPONDER, ADMIN, and OWNER roles", async () => {
      mockOrgs.requireIncidentWrite = vi.fn().mockResolvedValue("RESPONDER");

      // Setup client query mock for ack:
      // 1: BEGIN
      // 2: SELECT FOR UPDATE
      // 3: clock_timestamp
      // 4: UPDATE incidents
      // 5: INSERT incident_events
      // 6: UPDATE notification_deliveries
      // 7: advisory lock
      // 8: INSERT domain_events
      // 9: INSERT outbox_events
      // 10: SELECT incidents
      // 11: SELECT incident_events
      // 12: SELECT notification_deliveries
      // 13: COMMIT
      (mockClient.query as any)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: incidentId, organization_id: orgId, monitor_id: monitorId, status: "OPEN", opened_at: new Date() }],
        }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({ rows: [{ time: new Date() }] }) // clock_timestamp
        .mockResolvedValueOnce({}) // UPDATE incidents
        .mockResolvedValueOnce({}) // INSERT incident_events
        .mockResolvedValueOnce({}) // UPDATE notification_deliveries
        .mockResolvedValueOnce({}) // advisory lock
        .mockResolvedValueOnce({}) // INSERT domain_events
        .mockResolvedValueOnce({}) // INSERT outbox_events
        .mockResolvedValueOnce({
          rows: [{ id: incidentId, organization_id: orgId, monitor_id: monitorId, status: "ACKNOWLEDGED", opened_at: new Date(), acknowledged_at: new Date(), acknowledged_by: userId }],
        }) // SELECT incidents
        .mockResolvedValueOnce({ rows: [] }) // SELECT incident_events
        .mockResolvedValueOnce({ rows: [] }) // SELECT notification_deliveries
        .mockResolvedValueOnce({}); // COMMIT

      const res = await service.ackIncident(orgId, userId, incidentId);
      expect(res.status).toBe("ACKNOWLEDGED");
      expect(mockOrgs.requireIncidentWrite).toHaveBeenCalledWith(orgId, userId);
    });
  });

  describe("Tenant isolation & not found", () => {
    it("throws 404 when incident does not belong to organization on ACK", async () => {
      (mockClient.query as any)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}); // ROLLBACK

      await expect(service.ackIncident(orgId, userId, "nonexistent-id")).rejects.toThrow(NotFoundException);
    });

    it("throws 404 when incident does not belong to organization on Resolve", async () => {
      (mockClient.query as any)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}); // ROLLBACK

      await expect(service.resolveIncident(orgId, userId, "nonexistent-id")).rejects.toThrow(NotFoundException);
    });
  });

  describe("Transition & Idempotency invariants", () => {
    it("ACK on OPEN incident transitions to ACKNOWLEDGED and cancels pending deliveries", async () => {
      (mockClient.query as any)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: incidentId, organization_id: orgId, monitor_id: monitorId, status: "OPEN", opened_at: new Date() }],
        })
        .mockResolvedValueOnce({ rows: [{ time: new Date() }] }) // clock_timestamp
        .mockResolvedValueOnce({}) // UPDATE incidents
        .mockResolvedValueOnce({}) // INSERT incident_events
        .mockResolvedValueOnce({}) // UPDATE notification_deliveries CANCEL
        .mockResolvedValueOnce({}) // advisory lock
        .mockResolvedValueOnce({}) // INSERT domain_events
        .mockResolvedValueOnce({}) // INSERT outbox_events
        .mockResolvedValueOnce({
          rows: [{ id: incidentId, organization_id: orgId, monitor_id: monitorId, status: "ACKNOWLEDGED", opened_at: new Date(), acknowledged_at: new Date(), acknowledged_by: userId }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({}); // COMMIT

      const res = await service.ackIncident(orgId, userId, incidentId);
      expect(res.status).toBe("ACKNOWLEDGED");

      // Verify notification deliveries cancellation query was invoked
      const queries = (mockClient.query as any).mock.calls.map((c: any[]) => c[0]);
      expect(queries.some((q: string) => typeof q === "string" && q.includes("UPDATE notification_deliveries SET status='CANCELED'"))).toBe(true);
    });

    it("ACK on ACKNOWLEDGED incident is idempotent", async () => {
      (mockClient.query as any)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: incidentId, organization_id: orgId, monitor_id: monitorId, status: "ACKNOWLEDGED", opened_at: new Date(), acknowledged_at: new Date(), acknowledged_by: "someone" }],
        })
        .mockResolvedValueOnce({
          rows: [{ id: incidentId, organization_id: orgId, monitor_id: monitorId, status: "ACKNOWLEDGED", opened_at: new Date(), acknowledged_at: new Date(), acknowledged_by: "someone" }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({}); // COMMIT

      const res = await service.ackIncident(orgId, userId, incidentId);
      expect(res.status).toBe("ACKNOWLEDGED");

      // Verify no UPDATE query was executed
      const queries = (mockClient.query as any).mock.calls.map((c: any[]) => c[0]);
      expect(queries.some((q: string) => typeof q === "string" && q.includes("UPDATE incidents SET"))).toBe(false);
    });

    it("ACK on RESOLVED incident throws 409 ConflictException", async () => {
      (mockClient.query as any)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: incidentId, organization_id: orgId, monitor_id: monitorId, status: "RESOLVED", opened_at: new Date(), resolved_at: new Date() }],
        })
        .mockResolvedValueOnce({}); // ROLLBACK

      await expect(service.ackIncident(orgId, userId, incidentId)).rejects.toThrow(ConflictException);
    });

    it("Resolve on OPEN incident transitions to RESOLVED and cancels pending deliveries", async () => {
      (mockClient.query as any)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: incidentId, organization_id: orgId, monitor_id: monitorId, status: "OPEN", opened_at: new Date() }],
        })
        .mockResolvedValueOnce({ rows: [{ time: new Date() }] }) // clock_timestamp
        .mockResolvedValueOnce({}) // UPDATE incidents
        .mockResolvedValueOnce({}) // INSERT incident_events
        .mockResolvedValueOnce({}) // UPDATE notification_deliveries CANCEL
        .mockResolvedValueOnce({}) // advisory lock
        .mockResolvedValueOnce({}) // INSERT domain_events
        .mockResolvedValueOnce({}) // INSERT outbox_events
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT primary channels for createRecoveryDeliveries
        .mockResolvedValueOnce({
          rows: [{ id: incidentId, organization_id: orgId, monitor_id: monitorId, status: "RESOLVED", opened_at: new Date(), resolved_at: new Date(), resolved_by: userId }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({}); // COMMIT

      const res = await service.resolveIncident(orgId, userId, incidentId);
      expect(res.status).toBe("RESOLVED");

      const queries = (mockClient.query as any).mock.calls.map((c: any[]) => c[0]);
      expect(queries.some((q: string) => typeof q === "string" && q.includes("UPDATE notification_deliveries SET status='CANCELED'"))).toBe(true);
    });

    it("Resolve on ACKNOWLEDGED incident transitions to RESOLVED", async () => {
      (mockClient.query as any)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: incidentId, organization_id: orgId, monitor_id: monitorId, status: "ACKNOWLEDGED", opened_at: new Date(), acknowledged_at: new Date(), acknowledged_by: "someone" }],
        })
        .mockResolvedValueOnce({ rows: [{ time: new Date() }] }) // clock_timestamp
        .mockResolvedValueOnce({}) // UPDATE incidents
        .mockResolvedValueOnce({}) // INSERT incident_events
        .mockResolvedValueOnce({}) // UPDATE notification_deliveries CANCEL
        .mockResolvedValueOnce({}) // advisory lock
        .mockResolvedValueOnce({}) // INSERT domain_events
        .mockResolvedValueOnce({}) // INSERT outbox_events
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT primary channels for createRecoveryDeliveries
        .mockResolvedValueOnce({
          rows: [{ id: incidentId, organization_id: orgId, monitor_id: monitorId, status: "RESOLVED", opened_at: new Date(), resolved_at: new Date(), resolved_by: userId }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({}); // COMMIT

      const res = await service.resolveIncident(orgId, userId, incidentId);
      expect(res.status).toBe("RESOLVED");
    });

    it("Resolve on RESOLVED incident is idempotent", async () => {
      (mockClient.query as any)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: incidentId, organization_id: orgId, monitor_id: monitorId, status: "RESOLVED", opened_at: new Date(), resolved_at: new Date(), resolved_by: "someone" }],
        })
        .mockResolvedValueOnce({
          rows: [{ id: incidentId, organization_id: orgId, monitor_id: monitorId, status: "RESOLVED", opened_at: new Date(), resolved_at: new Date(), resolved_by: "someone" }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({}); // COMMIT

      const res = await service.resolveIncident(orgId, userId, incidentId);
      expect(res.status).toBe("RESOLVED");

      const queries = (mockClient.query as any).mock.calls.map((c: any[]) => c[0]);
      expect(queries.some((q: string) => typeof q === "string" && q.includes("UPDATE incidents SET"))).toBe(false);
    });
  });

  describe("Controller routing", () => {
    it("routes ack request to service.ackIncident", async () => {
      const ackSpy = vi.spyOn(service, "ackIncident").mockResolvedValue({
        id: incidentId,
        organizationId: orgId,
        monitorId,
        status: "ACKNOWLEDGED",
        openedAt: new Date().toISOString(),
        acknowledgedAt: new Date().toISOString(),
        acknowledgedBy: userId,
        resolvedAt: null,
        resolvedBy: null,
        events: [],
        deliveries: [],
      });

      const req = { identity: { id: userId, email: "user@test.local" } } as unknown as ArgusRequest;
      const res = await controller.ack(req, orgId, incidentId);

      expect(ackSpy).toHaveBeenCalledWith(orgId, userId, incidentId);
      expect(res.status).toBe("ACKNOWLEDGED");
    });

    it("routes resolve request to service.resolveIncident", async () => {
      const resolveSpy = vi.spyOn(service, "resolveIncident").mockResolvedValue({
        id: incidentId,
        organizationId: orgId,
        monitorId,
        status: "RESOLVED",
        openedAt: new Date().toISOString(),
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: new Date().toISOString(),
        resolvedBy: userId,
        events: [],
        deliveries: [],
      });

      const req = { identity: { id: userId, email: "user@test.local" } } as unknown as ArgusRequest;
      const res = await controller.resolve(req, orgId, incidentId);

      expect(resolveSpy).toHaveBeenCalledWith(orgId, userId, incidentId);
      expect(res.status).toBe("RESOLVED");
    });
  });
});
