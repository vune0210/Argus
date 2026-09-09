import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { StatusPagesService } from "./status-pages.service";
import { StatusPagesController } from "./status-pages.controller";
import { PublicStatusPagesController } from "./public-status-pages.controller";
import type { OrganizationsService } from "../organizations/organizations.service";
import type { ArgusRequest } from "../common/request";

describe("StatusPages Module Unit Tests", () => {
  const orgId = "11111111-1111-4111-8111-111111111111";
  const userId = "user-admin-1";
  const pageId = "22222222-2222-4222-8222-222222222222";
  const monitorId = "33333333-3333-4333-8333-333333333333";

  let mockPool: any;
  let mockClient: any;
  let mockOrgs: Partial<OrganizationsService>;
  let service: StatusPagesService;
  let controller: StatusPagesController;
  let publicController: PublicStatusPagesController;

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
    };

    service = new StatusPagesService(mockPool as Pool, mockOrgs as OrganizationsService);
    controller = new StatusPagesController(service);
    publicController = new PublicStatusPagesController(service);
  });

  describe("StatusPagesService - Validation & RBAC", () => {
    it("rejects non-owner/non-admin from creating status pages", async () => {
      mockOrgs.requireMonitorWrite = vi.fn().mockRejectedValue(
        new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Forbidden" }),
      );

      await expect(
        service.createStatusPage(orgId, "viewer-user", {
          name: "Argus Status",
          slug: "argus-status",
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("rejects invalid slug patterns", async () => {
      // Too short
      await expect(
        service.createStatusPage(orgId, userId, {
          name: "Argus",
          slug: "ab",
        }),
      ).rejects.toThrow(BadRequestException);

      // Invalid characters
      await expect(
        service.createStatusPage(orgId, userId, {
          name: "Argus",
          slug: "invalid_slug_with_underscores",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects published status page with zero components", async () => {
      await expect(
        service.createStatusPage(orgId, userId, {
          name: "Argus Status",
          slug: "argus-status",
          published: true,
          components: [],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects duplicate monitor in components", async () => {
      await expect(
        service.createStatusPage(orgId, userId, {
          name: "Argus Status",
          slug: "argus-status",
          components: [
            { monitorId, publicName: "API 1" },
            { monitorId, publicName: "API 2" },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects component when monitor is not found or in another tenant", async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // Slug check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // Monitor check returns 0 found
        .mockResolvedValueOnce({}); // ROLLBACK

      await expect(
        service.createStatusPage(orgId, userId, {
          name: "Argus Status",
          slug: "argus-status",
          components: [{ monitorId, publicName: "API Gateway" }],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects slug collision with 409 STATUS_PAGE_SLUG_CONFLICT", async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: "existing-page" }], rowCount: 1 }) // Slug check finds collision
        .mockResolvedValueOnce({}); // ROLLBACK

      await expect(
        service.createStatusPage(orgId, userId, {
          name: "Argus Status",
          slug: "argus-status",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("creates valid status page and assigns position according to array order", async () => {
      const now = new Date();
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // Slug check: free
        .mockResolvedValueOnce({ rows: [{ id: monitorId }], rowCount: 1 }) // Monitor check: valid
        .mockResolvedValueOnce({
          rows: [
            {
              id: pageId,
              organization_id: orgId,
              name: "Argus Status",
              slug: "argus-status",
              description: "Public status",
              published: true,
              version: 1,
              created_at: now,
              updated_at: now,
            },
          ],
          rowCount: 1,
        }) // Insert page
        .mockResolvedValueOnce({
          rows: [
            {
              id: "comp-1",
              status_page_id: pageId,
              monitor_id: monitorId,
              public_name: "API Gateway",
              position: 0,
            },
          ],
          rowCount: 1,
        }) // Insert component
        .mockResolvedValueOnce({}); // COMMIT

      const res = await service.createStatusPage(orgId, userId, {
        name: "Argus Status",
        slug: "argus-status",
        published: true,
        description: "Public status",
        components: [{ monitorId, publicName: "API Gateway" }],
      });

      expect(res.id).toBe(pageId);
      expect(res.version).toBe(1);
      expect(res.components).toHaveLength(1);
      expect(res.components[0]!.position).toBe(0);
      expect(res.components[0]!.publicName).toBe("API Gateway");
    });

    it("rejects update with 409 VERSION_CONFLICT on version mismatch", async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: pageId, version: 2, slug: "argus-status" }],
          rowCount: 1,
        }) // Current page has version 2
        .mockResolvedValueOnce({}); // ROLLBACK

      await expect(
        service.updateStatusPage(orgId, userId, pageId, {
          version: 1, // Stale version
          name: "New Name",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("soft deletes status page", async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: pageId }],
        rowCount: 1,
      });

      await expect(service.deleteStatusPage(orgId, userId, pageId)).resolves.toBeUndefined();
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE status_pages"),
        [pageId, orgId, userId],
      );
    });
  });

  describe("StatusPagesService - Public Read Model", () => {
    it("throws NotFoundException when public page is not found or unpublished", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(service.getPublicStatusPage("unknown-slug")).rejects.toThrow(NotFoundException);
    });

    it("calculates overall status as MAJOR_OUTAGE when any component is DOWN", async () => {
      const now = new Date();
      // Query 1: Page & components
      mockPool.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: pageId,
              organization_id: orgId,
              name: "Public Status",
              slug: "public-status",
              description: null,
              updated_at: now,
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [
            {
              component_id: "c1",
              public_name: "Service A",
              position: 0,
              monitor_id: monitorId,
              health_state: "DOWN",
            },
            {
              component_id: "c2",
              public_name: "Service B",
              position: 1,
              monitor_id: "mon-2",
              health_state: "HEALTHY",
            },
          ],
          rowCount: 2,
        })
        // Query 2: Aggregated stats
        .mockResolvedValueOnce({
          rows: [
            {
              monitor_id: monitorId,
              total_24h: 100,
              valid_24h: 100,
              avail_24h: 90,
              total_7d: 700,
              valid_7d: 700,
              avail_7d: 680,
              total_30d: 3000,
              valid_30d: 3000,
              avail_30d: 2950,
            },
          ],
        })
        // Query 3: Incidents
        .mockResolvedValueOnce({
          rows: [
            {
              status: "OPEN",
              opened_at: now,
              resolved_at: null,
              component_name: "Service A",
            },
          ],
        });

      const res = await service.getPublicStatusPage("public-status");

      expect(res.name).toBe("Public Status");
      expect(res.slug).toBe("public-status");
      expect(res.overallStatus).toBe("MAJOR_OUTAGE");
      expect(res.components).toHaveLength(2);
      expect(res.components[0]!.status).toBe("MAJOR_OUTAGE");
      expect(res.components[0]!.uptime.last24Hours).toBe(90.0);
      expect(res.components[0]!.coverage.last24Hours).toBe(100.0);
      expect(res.incidents).toHaveLength(1);
      expect(res.incidents[0]!.componentName).toBe("Service A");
      expect(res.incidents[0]!.status).toBe("OPEN");

      // Verify privacy: absolutely no internal IDs or URLs
      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain(orgId);
      expect(serialized).not.toContain(pageId);
      expect(serialized).not.toContain(monitorId);
    });

    it("returns null uptime and 0 coverage when no executions exist", async () => {
      const now = new Date();
      mockPool.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: pageId,
              organization_id: orgId,
              name: "Public Status",
              slug: "public-status",
              description: null,
              updated_at: now,
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [
            {
              component_id: "c1",
              public_name: "Service A",
              position: 0,
              monitor_id: monitorId,
              health_state: "HEALTHY",
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [] }) // No executions
        .mockResolvedValueOnce({ rows: [] }); // No incidents

      const res = await service.getPublicStatusPage("public-status");

      expect(res.overallStatus).toBe("OPERATIONAL");
      expect(res.components[0]!.uptime.last24Hours).toBeNull();
      expect(res.components[0]!.coverage.last24Hours).toBe(0);
    });
  });

  describe("Controllers Delegation & Cache Headers", () => {
    it("delegates internal endpoints to service", async () => {
      const listSpy = vi.spyOn(service, "listStatusPages").mockResolvedValueOnce({ items: [] });
      const req = { identity: { id: userId, email: "user@test.local" } } as unknown as ArgusRequest;
      const res = await controller.listPages(req, orgId);
      expect(res).toEqual({ items: [] });
      expect(listSpy).toHaveBeenCalledWith(orgId, userId);
    });

    it("sets Cache-Control header on public endpoint", async () => {
      const mockResponse = {
        name: "Argus Public",
        slug: "argus-public",
        overallStatus: "OPERATIONAL" as const,
        updatedAt: new Date().toISOString(),
        components: [],
        incidents: [],
      };
      vi.spyOn(service, "getPublicStatusPage").mockResolvedValueOnce(mockResponse);

      const resMock = {
        setHeader: vi.fn(),
      } as any;

      const res = await publicController.getPublicPage("argus-public", resMock);

      expect(resMock.setHeader).toHaveBeenCalledWith(
        "Cache-Control",
        "public, max-age=15, stale-while-revalidate=30",
      );
      expect(res.name).toBe("Argus Public");
    });

    it("delegates putPage to service updateStatusPage", async () => {
      const body = { name: "Updated Page", version: 1 };
      const updateSpy = vi.spyOn(service, "updateStatusPage").mockResolvedValueOnce({
        id: "page-1",
        organizationId: orgId,
        name: "Updated Page",
        slug: "updated-page",
        description: null,
        published: true,
        version: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        components: [],
      });
      const req = { identity: { id: userId, email: "user@test.local" } } as unknown as ArgusRequest;
      const res = await controller.putPage(req, orgId, "page-1", body);
      expect(res.name).toBe("Updated Page");
      expect(updateSpy).toHaveBeenCalledWith(orgId, userId, "page-1", body);
    });

    it("delegates addComponent to service", async () => {
      const body = { monitorId: "mon-1", publicName: "API Gateway" };
      const addSpy = vi.spyOn(service, "addComponent").mockResolvedValueOnce({
        id: "comp-1",
        statusPageId: "page-1",
        monitorId: "mon-1",
        publicName: "API Gateway",
        position: 0,
        displayOrder: 0,
      });
      const req = { identity: { id: userId, email: "user@test.local" } } as unknown as ArgusRequest;
      const res = await controller.addComponent(req, orgId, "page-1", body);
      expect(res.id).toBe("comp-1");
      expect(addSpy).toHaveBeenCalledWith(orgId, userId, "page-1", body);
    });

    it("delegates removeComponent to service", async () => {
      const removeSpy = vi.spyOn(service, "removeComponent").mockResolvedValueOnce(undefined);
      const req = { identity: { id: userId, email: "user@test.local" } } as unknown as ArgusRequest;
      await controller.removeComponent(req, orgId, "page-1", "comp-1");
      expect(removeSpy).toHaveBeenCalledWith(orgId, userId, "page-1", "comp-1");
    });
  });
});

