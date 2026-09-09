import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { OrganizationsModule } from "../organizations/organizations.module";
import { PipelineCoreModule } from "../pipeline/pipeline.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { NotificationsWorker } from "./notifications.worker";

@Module({
  imports: [DatabaseModule, OrganizationsModule, PipelineCoreModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsWorker],
  exports: [NotificationsService, NotificationsWorker],
})
export class NotificationsModule {}
