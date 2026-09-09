import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import type { ArgusRequest } from "../common/request";
import { OrganizationId } from "../organizations/organization-id.decorator";
import { NotificationsService } from "./notifications.service";

@Controller("api/v1")
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    @Inject(NotificationsService) private readonly service: NotificationsService,
  ) {}

  @Get("notification-channels")
  listChannels(@Req() req: ArgusRequest, @OrganizationId() org: string) {
    return this.service.listChannels(org, req.identity!.id);
  }

  @Post("notification-channels")
  createChannel(
    @Req() req: ArgusRequest,
    @OrganizationId() org: string,
    @Body() body: unknown,
  ) {
    return this.service.createChannel(org, req.identity!.id, body);
  }

  @Get("notification-channels/:id")
  getChannel(
    @Req() req: ArgusRequest,
    @OrganizationId() org: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.getChannel(org, req.identity!.id, id);
  }

  @Put("notification-channels/:id")
  putChannel(
    @Req() req: ArgusRequest,
    @OrganizationId() org: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.service.updateChannel(org, req.identity!.id, id, body);
  }

  @Patch("notification-channels/:id")
  @Header("Deprecation", "true")
  updateChannel(
    @Req() req: ArgusRequest,
    @OrganizationId() org: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.service.updateChannel(org, req.identity!.id, id, body);
  }

  @Delete("notification-channels/:id")
  @HttpCode(204)
  deleteChannel(
    @Req() req: ArgusRequest,
    @OrganizationId() org: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.deleteChannel(org, req.identity!.id, id);
  }

  @Get("escalation-policy")
  getPolicy(@Req() req: ArgusRequest, @OrganizationId() org: string) {
    return this.service.getEscalationPolicy(org, req.identity!.id);
  }

  @Put("escalation-policy")
  updatePolicy(
    @Req() req: ArgusRequest,
    @OrganizationId() org: string,
    @Body() body: unknown,
  ) {
    return this.service.updateEscalationPolicy(org, req.identity!.id, body);
  }
}
