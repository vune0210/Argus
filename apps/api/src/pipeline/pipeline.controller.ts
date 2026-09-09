import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { setTimeout as delay } from "node:timers/promises";
import { AuthGuard } from "../auth/auth.guard";
import type { ArgusRequest } from "../common/request";
import { OrganizationId } from "../organizations/organization-id.decorator";
import { PipelineService } from "./pipeline.service";
import { ProbeAuthGuard, type ProbeRequest } from "./probe-auth";
import { validateResult } from "./result.validation";
import { PipelineMetrics } from "./metrics";

@Controller("api/v1")
@UseGuards(AuthGuard)
export class PipelineController {
  constructor(@Inject(PipelineService) private readonly pipeline: PipelineService) {}
  @Post("monitors/:id/run") @HttpCode(202)
  run(@Req() req: ArgusRequest, @OrganizationId() org: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.pipeline.run(org, req.identity!.id, id);
  }

  @Post("monitors/:id/evaluate") @HttpCode(202)
  evaluate(
    @Req() req: ArgusRequest,
    @OrganizationId() org: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("Idempotency-Key") idempotencyKey: string | undefined,
    @Body() body: { monitorVersion?: number },
  ) {
    if (!idempotencyKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      throw new BadRequestException({ code: "INVALID_HEADER", message: "Idempotency-Key header is required and must be a valid UUID" });
    }
    if (typeof body?.monitorVersion !== "number" || !Number.isInteger(body.monitorVersion) || body.monitorVersion < 1) {
      throw new BadRequestException({ code: "INVALID_PAYLOAD", message: "monitorVersion must be a positive integer" });
    }
    return this.pipeline.evaluate(org, req.identity!.id, id, idempotencyKey, body.monitorVersion);
  }
  @Get("monitors/:id/executions")
  executions(@Req() req: ArgusRequest, @OrganizationId() org: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.pipeline.executions(org, req.identity!.id, id);
  }
  @Get("executions/:id")
  execution(@Req() req: ArgusRequest, @OrganizationId() org: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.pipeline.execution(org, req.identity!.id, id);
  }
  @Get("monitors/:id/snapshot")
  snapshot(@Req() req: ArgusRequest, @OrganizationId() org: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.pipeline.snapshot(org, req.identity!.id, id);
  }
  @Get("incidents")
  incidents(@Req() req: ArgusRequest, @OrganizationId() org: string) { return this.pipeline.incidents(org, req.identity!.id); }
  @Get("incidents/:id")
  incident(@Req() req: ArgusRequest, @OrganizationId() org: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.pipeline.incident(org, req.identity!.id, id);
  }
  @Post("incidents/:id/ack")
  ack(@Req() req: ArgusRequest, @OrganizationId() org: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.pipeline.ackIncident(org, req.identity!.id, id);
  }
  @Post("incidents/:id/resolve")
  resolve(@Req() req: ArgusRequest, @OrganizationId() org: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.pipeline.resolveIncident(org, req.identity!.id, id);
  }
}

@Controller("api/v1/probe-leases")
@UseGuards(ProbeAuthGuard)
export class ProbeController {
  private polling = 0;
  constructor(@Inject(PipelineService) private readonly pipeline: PipelineService,
    @Inject(PipelineMetrics) private readonly metrics: PipelineMetrics) {}
  @Post()
  async lease(@Req() req: ProbeRequest, @Res() res: Response): Promise<void> {
    let closed = false;
    const onClose = () => { closed = true; };
    res.on("close", onClose);
    const end = Date.now() + 24_000;
    const start = Date.now();
    if (this.polling >= 1000) { res.off("close", onClose); res.status(503).json({ message: "Lease capacity exceeded" }); return; }
    this.polling++;
    try {
      while (!closed && Date.now() < end) {
        const lease = await this.pipeline.lease(req.probe);
        if (lease) { if (!closed) res.status(200).json(lease); return; }
        await delay(250);
      }
      if (!closed) res.status(204).end();
    } finally { this.polling--; this.metrics.observe("lease_latency", (Date.now() - start) / 1000); res.off("close", onClose); }
  }
  @Post(":id/heartbeat") @HttpCode(200)
  heartbeat(@Req() req: ProbeRequest, @Param("id", ParseUUIDPipe) id: string) { return this.pipeline.heartbeat(req.probe, id); }
  @Post(":id/result") @HttpCode(200)
  result(@Req() req: ProbeRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.pipeline.ingest(req.probe, id, validateResult(body));
  }
}

@Controller("metrics")
export class MetricsController {
  constructor(@Inject(PipelineMetrics) private readonly metrics: PipelineMetrics) {}
  @Get()
  get(@Res() res: Response) { res.type("text/plain").send(this.metrics.render()); }
}
