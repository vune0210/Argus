import { Injectable, type NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { NextFunction, Response } from "express";
import type { ArgusRequest } from "./request";

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: ArgusRequest, response: Response, next: NextFunction): void {
    const startedAt = Date.now();
    request.traceId = randomUUID();
    response.setHeader("X-Trace-Id", request.traceId);
    response.on("finish", () => {
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        service: "argus-api",
        environment: process.env.NODE_ENV ?? "development",
        traceId: request.traceId,
        method: request.method,
        path: request.originalUrl,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
      }));
    });
    next();
  }
}
