import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { RequestContextMiddleware } from "./common/request-context.middleware";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { MonitorsModule } from "./monitors/monitors.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { OrganizationsModule } from "./organizations/organizations.module";
import { PipelineModule } from "./pipeline/pipeline.module";
import { StatusPagesModule } from "./status-pages/status-pages.module";

@Module({ imports: [DatabaseModule, OrganizationsModule, AuthModule, MonitorsModule, HealthModule, PipelineModule, NotificationsModule, StatusPagesModule] })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes("*");
  }
}
