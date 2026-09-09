import { Controller, HttpCode, HttpStatus, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { BootstrapResponse } from "@argus/contracts";
import type { ArgusRequest } from "../common/request";
import { OrganizationsService } from "../organizations/organizations.service";
import { AuthGuard } from "./auth.guard";

@Controller("api/v1/auth")
export class AuthController {
  constructor(@Inject(OrganizationsService) private readonly organizations: OrganizationsService) {}

  @Post("bootstrap")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  bootstrap(@Req() request: ArgusRequest): Promise<BootstrapResponse> {
    return this.organizations.bootstrap(request.identity!);
  }
}
