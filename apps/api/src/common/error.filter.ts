import { ArgumentsHost, Catch, HttpException, HttpStatus, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import type { ArgusRequest } from "./request";

interface StructuredException {
  code?: string;
  message?: string | string[];
  details?: unknown;
}

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<ArgusRequest>();
    const response = context.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : undefined;
    const structured = typeof raw === "object" && raw !== null ? raw as StructuredException : undefined;
    const rawMessage = structured?.message ?? (typeof raw === "string" ? raw : undefined);
    const message = Array.isArray(rawMessage) ? rawMessage.join(", ") : rawMessage;

    if (!(exception instanceof HttpException)) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        service: "argus-api",
        environment: process.env.NODE_ENV ?? "development",
        traceId: request.traceId,
        error: exception instanceof Error ? exception.message : "Unknown error",
      }));
    }

    response.status(status).json({
      code: structured?.code ?? `HTTP_${status}`,
      message: message ?? (status === 500 ? "Internal server error" : "Request failed"),
      ...(structured?.details === undefined ? {} : { details: structured.details }),
      traceId: request.traceId,
    });
  }
}
