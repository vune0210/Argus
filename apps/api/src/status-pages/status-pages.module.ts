import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { OrganizationsModule } from "../organizations/organizations.module";
import { StatusPagesController } from "./status-pages.controller";
import { PublicStatusPagesController } from "./public-status-pages.controller";
import { StatusPagesService } from "./status-pages.service";

@Module({
  imports: [DatabaseModule, OrganizationsModule],
  controllers: [StatusPagesController, PublicStatusPagesController],
  providers: [StatusPagesService],
  exports: [StatusPagesService],
})
export class StatusPagesModule {}
