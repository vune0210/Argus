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
import { StatusPagesService } from "./status-pages.service";
import type { AddStatusPageComponentRequest, CreateStatusPageRequest, UpdateStatusPageRequest } from "@argus/contracts";

@Controller("api/v1")
@UseGuards(AuthGuard)
export class StatusPagesController {
  constructor(
    @Inject(StatusPagesService) private readonly service: StatusPagesService,
  ) {}

  @Get("status-pages")
  listPages(@Req() req: ArgusRequest, @OrganizationId() org: string) {
    return this.service.listStatusPages(org, req.identity!.id);
  }

  @Post("status-pages")
  createPage(
    @Req() req: ArgusRequest,
    @OrganizationId() org: string,
    @Body() body: CreateStatusPageRequest,
  ) {
    return this.service.createStatusPage(org, req.identity!.id, body);
  }

  @Get("status-pages/:id")
  getPage(
    @Req() req: ArgusRequest,
    @OrganizationId() org: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.getStatusPage(org, req.identity!.id, id);
  }

  @Put("status-pages/:id")
  putPage(
    @Req() req: ArgusRequest,
    @OrganizationId() org: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateStatusPageRequest,
  ) {
    return this.service.updateStatusPage(org, req.identity!.id, id, body);
  }

  @Patch("status-pages/:id")
  @Header("Deprecation", "true")
  updatePage(
    @Req() req: ArgusRequest,
    @OrganizationId() org: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateStatusPageRequest,
  ) {
    return this.service.updateStatusPage(org, req.identity!.id, id, body);
  }

  @Post("status-pages/:id/components")
  addComponent(
    @Req() req: ArgusRequest,
    @OrganizationId() org: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AddStatusPageComponentRequest,
  ) {
    return this.service.addComponent(org, req.identity!.id, id, body);
  }

  @Delete("status-pages/:id/components/:componentId")
  @HttpCode(204)
  removeComponent(
    @Req() req: ArgusRequest,
    @OrganizationId() org: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("componentId", ParseUUIDPipe) componentId: string,
  ) {
    return this.service.removeComponent(org, req.identity!.id, id, componentId);
  }

  @Delete("status-pages/:id")
  @HttpCode(204)
  deletePage(
    @Req() req: ArgusRequest,
    @OrganizationId() org: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.deleteStatusPage(org, req.identity!.id, id);
  }
}
