import { Module } from "@nestjs/common";
import { OrganizationsModule } from "../organizations/organizations.module";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";

@Module({
  imports: [OrganizationsModule],
  controllers: [AuthController],
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class AuthModule {}
