import {
  Controller,
  Get,
  Inject,
  Param,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { StatusPagesService } from "./status-pages.service";

@Controller("api/public/v1")
export class PublicStatusPagesController {
  constructor(
    @Inject(StatusPagesService) private readonly service: StatusPagesService,
  ) {}

  @Get("status-pages/:slug")
  async getPublicPage(
    @Param("slug") slug: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "public, max-age=15, stale-while-revalidate=30");
    return this.service.getPublicStatusPage(slug);
  }
}
