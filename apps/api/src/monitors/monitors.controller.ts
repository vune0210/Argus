import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Monitor } from "@argus/contracts";
import type { ArgusRequest } from "../common/request";
import { AuthGuard } from "../auth/auth.guard";
import { OrganizationId } from "../organizations/organization-id.decorator";
import { validateMonitorCreate, validateMonitorUpdate } from "./monitor.validation";
import { MonitorsService } from "./monitors.service";

@Controller("api/v1/monitors")
@UseGuards(AuthGuard)
export class MonitorsController {
  constructor(@Inject(MonitorsService) private readonly monitors: MonitorsService) {}

  @Get()
  list(
    @Req() request: ArgusRequest,
    @OrganizationId() organizationId: string,
    @Query("limit") rawLimit?: string,
    @Query("cursor") cursor?: string,
  ): Promise<{ items: Monitor[]; nextCursor: string | null }> {
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException({ code: "INVALID_LIMIT", message: "Monitor page limit must be an integer between 1 and 100" });
    }
    return this.monitors.list(organizationId, request.identity!.id, limit, cursor);
  }

  @Post()
  create(@Req() request: ArgusRequest, @OrganizationId() organizationId: string, @Body() body: unknown): Promise<Monitor> {
    return this.monitors.create(organizationId, request.identity!.id, validateMonitorCreate(body));
  }

  @Get(":id")
  get(@Req() request: ArgusRequest, @OrganizationId() organizationId: string, @Param("id", ParseUUIDPipe) id: string): Promise<Monitor> {
    return this.monitors.get(organizationId, request.identity!.id, id);
  }

  @Patch(":id")
  update(
    @Req() request: ArgusRequest,
    @OrganizationId() organizationId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<Monitor> {
    return this.monitors.update(organizationId, request.identity!.id, id, validateMonitorUpdate(body));
  }

  @Get(":id/timeseries")
  timeseries(
    @Req() request: ArgusRequest,
    @OrganizationId() organizationId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("window") window?: string,
  ) {
    const validWindows = ["1h", "6h", "24h"];
    const w = window ?? "24h";
    if (!validWindows.includes(w)) {
      throw new BadRequestException({ code: "INVALID_WINDOW", message: "window must be one of: 1h, 6h, 24h" });
    }
    return this.monitors.getTimeseries(organizationId, request.identity!.id, id, w);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Req() request: ArgusRequest, @OrganizationId() organizationId: string, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.monitors.delete(organizationId, request.identity!.id, id);
  }
}
