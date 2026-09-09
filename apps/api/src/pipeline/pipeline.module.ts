import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { OrganizationsModule } from "../organizations/organizations.module";
import { PipelineController, ProbeController, MetricsController } from "./pipeline.controller";
import { EventsController } from "./events.controller";
import { ProbeAuthGuard } from "./probe-auth";
import { PipelineService } from "./pipeline.service";
import { RedisStreams } from "./redis-streams";
import { PipelineMetrics } from "./metrics";

@Module({ imports: [OrganizationsModule], providers: [PipelineService, RedisStreams, PipelineMetrics], exports: [PipelineService, RedisStreams, PipelineMetrics] })
export class PipelineCoreModule {}

@Module({ imports: [PipelineCoreModule, AuthModule, OrganizationsModule],
  controllers: [PipelineController, ProbeController, EventsController, MetricsController], providers: [ProbeAuthGuard] })
export class PipelineModule {}
