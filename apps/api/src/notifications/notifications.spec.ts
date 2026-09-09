import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { NotificationsService } from "./notifications.service";
import { NotificationsWorker } from "./notifications.worker";
import { NotificationsController } from "./notifications.controller";
import type { NotificationProvider } from "./notifications.provider";
import type { OrganizationsService } from "../organizations/organizations.service";
import type { RedisStreams } from "../pipeline/redis-streams";
import type { ArgusRequest } from "../common/request";

describe("Notifications Module Unit Tests", () => {
  const orgId = "11111111-1111-4111-8111-111111111111";
  const userId = "user-admin-1";
  const channelId = "33333333-3333-4333-8333-333333333333";
  const incidentId = "44444444-4444-4444-8444-444444444444";
  const deliveryId = "55555555-5555-4555-8555-555555555555";

  let mockPool: any;
  let mockClient: any;
  let mockOrgs: Partial<OrganizationsService>;
  let mockStreams: Partial<RedisStreams>;
  let mockProvider: NotificationProvider;
  let service: NotificationsService;
  let worker: NotificationsWorker;
  let controller: NotificationsController;

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
      membership: vi.fn().mockResolvedValue("ADMIN"),
      requireMonitorWrite: vi.fn().mockResolvedValue("ADMIN"),
      requireIncidentWrite: vi.fn().mockResolvedValue("ADMIN"),
    };

    mockStreams = {
      publish: vi.fn().mockResolvedValue("1-0"),
    };

    mockProvider = {
      send: vi.fn().mockResolvedValue({ success: true, attempts: 1 }),
    };

    service = new NotificationsService(
      mockPool as Pool,
      mockOrgs as OrganizationsService,
      mockStreams as RedisStreams,
    );

    worker = new NotificationsWorker(
      mockPool as Pool,
      mockStreams as RedisStreams,
    );
    worker.setProvider(mockProvider);

    controller = new NotificationsController(service);
  });

  describe("NotificationsService - Channel Validation & RBAC", () => {
    it("rejects non-owner/non-admin from creating notification channels", async () => {
      mockOrgs.requireMonitorWrite = vi.fn().mockRejectedValue(
        new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Forbidden" }),
      );

      await expect(
        service.createChannel(orgId, "viewer-user", {
          name: "Slack Ops",
          type: "SLACK",
          secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:slack",
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("requires AWS Secrets Manager ARN for SLACK and forbids email", async () => {
      // Invalid ARN format
      await expect(
        service.createChannel(orgId, userId, {
          name: "Slack",
          type: "SLACK",
          secretArn: "https://hooks.slack.com/services/xxx",
        }),
      ).rejects.toThrow(BadRequestException);

      // Contains forbidden email
      await expect(
        service.createChannel(orgId, userId, {
          name: "Slack",
          type: "SLACK",
          secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:slack",
          email: "forbidden@example.com",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("requires valid email for EMAIL and forbids secretArn", async () => {
      // Invalid email
      await expect(
        service.createChannel(orgId, userId, {
          name: "Email Ops",
          type: "EMAIL",
          email: "invalid-email-address",
        }),
      ).rejects.toThrow(BadRequestException);

      // Contains forbidden secretArn
      await expect(
        service.createChannel(orgId, userId, {
          name: "Email Ops",
          type: "EMAIL",
          email: "ops@example.com",
          secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:slack",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects unknown/unexpected properties in payload", async () => {
      await expect(
        service.createChannel(orgId, userId, {
          name: "Email Ops",
          type: "EMAIL",
          email: "ops@example.com",
          maliciousField: "attack",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("creates a valid SLACK channel and returns masked safe payload without webhooks", async () => {
      vi.mocked(mockPool.query!).mockResolvedValueOnce({
        rows: [
          {
            id: channelId,
            organization_id: orgId,
            type: "SLACK",
            name: "Primary Slack",
            config: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:slack" },
            enabled: true,
            created_at: new Date("2026-01-01T00:00:00Z"),
            updated_at: new Date("2026-01-01T00:00:00Z"),
          },
        ],
        rowCount: 1,
      } as any);

      const res = await service.createChannel(orgId, userId, {
        name: "Primary Slack",
        type: "SLACK",
        secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:slack",
      });

      expect(res.id).toBe(channelId);
      expect(res.name).toBe("Primary Slack");
      expect(res.config.secretArn).toBe("arn:aws:secretsmanager:us-east-1:123456789012:secret:slack");
      expect((res.config as any).webhook).toBeUndefined();
    });

    it("rejects deletion of channel with 409 CHANNEL_IN_USE if used by escalation step", async () => {
      // Channel exists
      vi.mocked(mockPool.query!)
        .mockResolvedValueOnce({ rows: [{ id: channelId }], rowCount: 1 } as any)
        // In use by escalation step
        .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 } as any);

      await expect(service.deleteChannel(orgId, userId, channelId)).rejects.toThrow(ConflictException);
    });

    it("throws NotFoundException when updating non-existent channel", async () => {
      vi.mocked(mockPool.query!).mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      await expect(
        service.updateChannel(orgId, userId, "non-existent-channel", { name: "Updated" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when deleting non-existent channel", async () => {
      vi.mocked(mockPool.query!).mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      await expect(
        service.deleteChannel(orgId, userId, "non-existent-channel"),
      ).rejects.toThrow(NotFoundException);
    });

    it("deletes channel successfully when not in use", async () => {
      vi.mocked(mockPool.query!)
        .mockResolvedValueOnce({ rows: [{ id: channelId }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        .mockResolvedValueOnce({ rowCount: 1 } as any);

      await expect(service.deleteChannel(orgId, userId, channelId)).resolves.toBeUndefined();
    });
  });

  describe("NotificationsService - Escalation Policy", () => {
    it("requires exactly 3 steps (PRIMARY, SECONDARY, TEAM)", async () => {
      // Only 2 steps provided
      await expect(
        service.updateEscalationPolicy(orgId, userId, {
          name: "Incomplete Policy",
          steps: [
            { name: "PRIMARY", delaySeconds: 0, channelId },
            { name: "SECONDARY", delaySeconds: 300, channelId },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("validates that all referenced channels exist in the organization", async () => {
      // Channel check fails
      vi.mocked(mockPool.query!).mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await expect(
        service.updateEscalationPolicy(orgId, userId, {
          name: "Test Policy",
          steps: [
            { name: "PRIMARY", delaySeconds: 0, channelId: "non-existent" },
            { name: "SECONDARY", delaySeconds: 300, channelId: "non-existent" },
            { name: "TEAM", delaySeconds: 600, channelId: "non-existent" },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects duplicate channels within the same step", async () => {
      await expect(
        service.updateEscalationPolicy(orgId, userId, {
          name: "Duplicate Step Channel Policy",
          steps: [
            { name: "PRIMARY", delaySeconds: 0, channelIds: [channelId, channelId] },
            { name: "SECONDARY", delaySeconds: 300, channelIds: [channelId] },
            { name: "TEAM", delaySeconds: 600, channelIds: [channelId] },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("requires Primary step to have at least one enabled Slack and one enabled Email channel", async () => {
      const emailChanId = "77777777-7777-4777-8777-777777777777";
      const slackChanId = "88888888-8888-4888-8888-888888888888";

      // Mock only Slack for Primary step (missing Email)
      vi.mocked(mockPool.query!).mockResolvedValueOnce({
        rows: [
          { id: slackChanId, type: "SLACK", enabled: true },
        ],
        rowCount: 1,
      } as any);

      await expect(
        service.updateEscalationPolicy(orgId, userId, {
          name: "Slack Only Policy",
          steps: [
            { name: "PRIMARY", delaySeconds: 0, channelIds: [slackChanId] },
            { name: "SECONDARY", delaySeconds: 300, channelIds: [slackChanId] },
            { name: "TEAM", delaySeconds: 600, channelIds: [slackChanId] },
          ],
        }),
      ).rejects.toThrow(BadRequestException);

      // Both Slack and Email present and enabled -> succeeds
      vi.mocked(mockPool.query!).mockResolvedValueOnce({
        rows: [
          { id: slackChanId, type: "SLACK", enabled: true },
          { id: emailChanId, type: "EMAIL", enabled: true },
        ],
        rowCount: 2,
      } as any);

      vi.mocked(mockClient.query!)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: "pol-1", organization_id: orgId, name: "Dual Policy" }], rowCount: 1 } as any) // policy upsert
        .mockResolvedValueOnce({}) // delete steps
        .mockResolvedValueOnce({ rows: [{ id: "step-1", step_order: 0, delay_seconds: 0, channel_id: slackChanId }], rowCount: 1 } as any)
        .mockResolvedValueOnce({}) // insert step_channel 1
        .mockResolvedValueOnce({}) // insert step_channel 2
        .mockResolvedValueOnce({ rows: [{ id: "step-2", step_order: 1, delay_seconds: 300, channel_id: emailChanId }], rowCount: 1 } as any)
        .mockResolvedValueOnce({}) // insert step_channel
        .mockResolvedValueOnce({ rows: [{ id: "step-3", step_order: 2, delay_seconds: 600, channel_id: emailChanId }], rowCount: 1 } as any)
        .mockResolvedValueOnce({}) // insert step_channel
        .mockResolvedValueOnce({}); // COMMIT

      const updated = await service.updateEscalationPolicy(orgId, userId, {
        name: "Dual Policy",
        steps: [
          { name: "PRIMARY", delaySeconds: 0, channelIds: [slackChanId, emailChanId] },
          { name: "SECONDARY", delaySeconds: 300, channelIds: [emailChanId] },
          { name: "TEAM", delaySeconds: 600, channelIds: [emailChanId] },
        ],
      });

      expect(updated.steps[0].channelIds).toEqual([slackChanId, emailChanId]);
      expect(updated.steps[0].channelId).toBe(slackChanId);
    });
  });

  describe("NotificationsWorker - Claims, Retries, and Cancellation", () => {
    it("cancels delivery without provider call if incident was acknowledged or resolved after claim", async () => {
      // 1. Claim delivery in PENDING
      vi.mocked(mockClient.query!)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [
            {
              id: deliveryId,
              organization_id: orgId,
              incident_id: incidentId,
              escalation_step_id: "step-1",
              channel_id: channelId,
              status: "PENDING",
              attempts: 0,
              channel_type: "SLACK",
              channel_config: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:slack" },
              channel_enabled: true,
              monitor_name: "API Monitor",
              monitor_regions: ["ap-southeast-1"],
              incident_status: "OPEN",
              incident_opened_at: new Date(),
            },
          ],
          rowCount: 1,
        } as any) // SELECT FOR UPDATE SKIP LOCKED
        .mockResolvedValueOnce({}) // UPDATE to SENDING
        .mockResolvedValueOnce({}); // COMMIT

      // 2. Incident recheck returns ACKNOWLEDGED post-commit
      vi.mocked(mockPool.query!)
        .mockResolvedValueOnce({
          rows: [{ status: "ACKNOWLEDGED" }],
          rowCount: 1,
        } as any) // SELECT incident status
        .mockResolvedValueOnce({}) // UPDATE delivery to CANCELED
        .mockResolvedValueOnce({}) // domain event
        .mockResolvedValueOnce({}); // outbox event

      const count = await worker.process();

      expect(count).toBe(1);
      // Ensure provider send was NOT called
      expect(mockProvider.send).not.toHaveBeenCalled();
    });

    it("sends notification and marks delivery SENT on provider success", async () => {
      // Claim delivery
      vi.mocked(mockClient.query!)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [
            {
              id: deliveryId,
              organization_id: orgId,
              incident_id: incidentId,
              escalation_step_id: "step-1",
              channel_id: channelId,
              status: "PENDING",
              attempts: 0,
              channel_type: "SLACK",
              channel_config: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:slack" },
              channel_enabled: true,
              monitor_name: "API Monitor",
              monitor_regions: ["ap-southeast-1"],
              incident_status: "OPEN",
              incident_opened_at: new Date(),
            },
          ],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({}) // UPDATE to SENDING
        .mockResolvedValueOnce({}); // COMMIT

      // Incident check: still OPEN
      vi.mocked(mockPool.query!)
        .mockResolvedValueOnce({ rows: [{ status: "OPEN" }], rowCount: 1 } as any)
        .mockResolvedValueOnce({}) // UPDATE delivery to SENT
        .mockResolvedValueOnce({}) // domain event
        .mockResolvedValueOnce({}); // outbox event

      const count = await worker.process();

      expect(count).toBe(1);
      expect(mockProvider.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SLACK",
          payload: expect.objectContaining({
            monitorName: "API Monitor",
            incidentStatus: "OPEN",
          }),
        }),
      );
    });

    it("sends recovery notification when event_kind is INCIDENT_RESOLVED even though incident is RESOLVED", async () => {
      // Claim recovery delivery
      vi.mocked(mockClient.query!)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [
            {
              id: deliveryId,
              organization_id: orgId,
              incident_id: incidentId,
              escalation_step_id: "step-1",
              channel_id: channelId,
              event_kind: "INCIDENT_RESOLVED",
              status: "PENDING",
              attempts: 0,
              channel_type: "EMAIL",
              channel_config: { recipient: "ops@example.com" },
              channel_enabled: true,
              monitor_name: "API Monitor",
              monitor_regions: ["ap-southeast-1"],
              incident_status: "RESOLVED",
              incident_opened_at: new Date(),
            },
          ],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({}) // UPDATE to SENDING
        .mockResolvedValueOnce({}); // COMMIT

      // Incident check: status is RESOLVED
      vi.mocked(mockPool.query!)
        .mockResolvedValueOnce({ rows: [{ status: "RESOLVED" }], rowCount: 1 } as any)
        .mockResolvedValueOnce({}) // UPDATE delivery to SENT
        .mockResolvedValueOnce({}) // domain event
        .mockResolvedValueOnce({}); // outbox event

      const count = await worker.process();

      expect(count).toBe(1);
      expect(mockProvider.send).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKind: "INCIDENT_RESOLVED",
          type: "EMAIL",
          payload: expect.objectContaining({
            incidentStatus: "RESOLVED",
            eventKind: "INCIDENT_RESOLVED",
          }),
        }),
      );
    });

    it("applies 429 Retry-After override when provider returns rate limited", async () => {
      // Provider returns 429 with retryAfterSeconds: 45
      vi.mocked(mockProvider.send).mockResolvedValueOnce({
        success: false,
        error: "RATE_LIMITED",
        retryAfterSeconds: 45,
      });

      // Claim delivery
      vi.mocked(mockClient.query!)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rows: [
            {
              id: deliveryId,
              organization_id: orgId,
              incident_id: incidentId,
              escalation_step_id: "step-1",
              channel_id: channelId,
              status: "PENDING",
              attempts: 0,
              channel_type: "EMAIL",
              channel_config: { recipient: "ops@example.com" },
              channel_enabled: true,
              monitor_name: "API Monitor",
              monitor_regions: ["eu-central-1"],
              incident_status: "OPEN",
              incident_opened_at: new Date(),
            },
          ],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      let updateQuery = "";
      let updateParams: any[] = [];
      vi.mocked(mockPool.query!).mockImplementation(async (query: any, params?: any) => {
        if (typeof query === "string" && query.includes("status = 'PENDING'")) {
          updateQuery = query;
          updateParams = params ?? [];
        }
        return { rows: [{ status: "OPEN" }], rowCount: 1 } as any;
      });

      await worker.process();

      expect(updateQuery).toContain("next_attempt_at = clock_timestamp() + ($2 || ' seconds')::interval");
      // Parameter 2 should be 45 (retryAfterSeconds)
      expect(updateParams[1]).toBe(45);
      // Safe error code should be recorded
      expect(updateParams[2]).toBe("RATE_LIMITED");
    });

    it("recovers orphaned deliveries stuck in SENDING with expired lock", async () => {
      vi.mocked(mockPool.query!).mockResolvedValueOnce({
        rows: [{ id: deliveryId }],
        rowCount: 1,
      } as any);

      const recovered = await worker.recover();

      expect(recovered).toBe(1);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE status = 'SENDING' AND locked_until < clock_timestamp()"),
      );
    });
  });

  describe("NotificationsController Delegation", () => {
    it("delegates listChannels to service", async () => {
      const spy = vi.spyOn(service, "listChannels").mockResolvedValueOnce({ items: [] });
      const req = { identity: { id: userId, email: "user@test.local" } } as unknown as ArgusRequest;
      const result = await controller.listChannels(req, orgId);
      expect(result).toEqual({ items: [] });
      expect(spy).toHaveBeenCalledWith(orgId, userId);
    });

    it("delegates createChannel to service", async () => {
      const body = {
        name: "Slack",
        type: "SLACK" as const,
        secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:slack",
      };
      const spy = vi.spyOn(service, "createChannel").mockResolvedValueOnce({ id: channelId } as any);
      const req = { identity: { id: userId, email: "user@test.local" } } as unknown as ArgusRequest;
      const result = await controller.createChannel(req, orgId, body);
      expect(result).toEqual({ id: channelId });
      expect(spy).toHaveBeenCalledWith(orgId, userId, body);
    });

    it("delegates updateChannel to service", async () => {
      const body = { name: "Updated Slack" };
      const spy = vi.spyOn(service, "updateChannel").mockResolvedValueOnce({ id: channelId } as any);
      const req = { identity: { id: userId, email: "user@test.local" } } as unknown as ArgusRequest;
      const result = await controller.updateChannel(req, orgId, channelId, body);
      expect(result).toEqual({ id: channelId });
      expect(spy).toHaveBeenCalledWith(orgId, userId, channelId, body);
    });

    it("delegates deleteChannel to service", async () => {
      const spy = vi.spyOn(service, "deleteChannel").mockResolvedValueOnce();
      const req = { identity: { id: userId, email: "user@test.local" } } as unknown as ArgusRequest;
      await controller.deleteChannel(req, orgId, channelId);
      expect(spy).toHaveBeenCalledWith(orgId, userId, channelId);
    });

    it("delegates getPolicy to service", async () => {
      const spy = vi.spyOn(service, "getEscalationPolicy").mockResolvedValueOnce({
        id: "pol-1",
        organizationId: orgId,
        name: "Default Policy",
        steps: [],
      });
      const req = { identity: { id: userId, email: "user@test.local" } } as unknown as ArgusRequest;
      const result = await controller.getPolicy(req, orgId);
      expect(result.name).toBe("Default Policy");
      expect(spy).toHaveBeenCalledWith(orgId, userId);
    });

    it("delegates updatePolicy to service", async () => {
      const body = { name: "New Policy", steps: [] };
      const spy = vi.spyOn(service, "updateEscalationPolicy").mockResolvedValueOnce({
        id: "pol-1",
        organizationId: orgId,
        name: "New Policy",
        steps: [],
      });
      const req = { identity: { id: userId, email: "user@test.local" } } as unknown as ArgusRequest;
      const result = await controller.updatePolicy(req, orgId, body);
      expect(result.name).toBe("New Policy");
      expect(spy).toHaveBeenCalledWith(orgId, userId, body);
    });

    it("delegates getChannel to service", async () => {
      const mockChannel = {
        id: "chan-1",
        organizationId: orgId,
        type: "EMAIL" as const,
        name: "Alerts",
        config: { recipient: "alerts@example.com" },
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const spy = vi.spyOn(service, "getChannel").mockResolvedValueOnce(mockChannel);
      const req = { identity: { id: userId, email: "user@test.local" } } as unknown as ArgusRequest;
      const result = await controller.getChannel(req, orgId, "chan-1");
      expect(result).toEqual(mockChannel);
      expect(spy).toHaveBeenCalledWith(orgId, userId, "chan-1");
    });

    it("delegates putChannel to service updateChannel", async () => {
      const body = { name: "Updated Email" };
      const mockChannel = {
        id: "chan-1",
        organizationId: orgId,
        type: "EMAIL" as const,
        name: "Updated Email",
        config: { recipient: "alerts@example.com" },
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const spy = vi.spyOn(service, "updateChannel").mockResolvedValueOnce(mockChannel);
      const req = { identity: { id: userId, email: "user@test.local" } } as unknown as ArgusRequest;
      const result = await controller.putChannel(req, orgId, "chan-1", body);
      expect(result).toEqual(mockChannel);
      expect(spy).toHaveBeenCalledWith(orgId, userId, "chan-1", body);
    });
  });
});

