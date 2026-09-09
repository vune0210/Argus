import { BadRequestException, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { ArgusRequest } from "../common/request";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const OrganizationId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<ArgusRequest>();
  const value = request.header("x-argus-organization-id");
  if (!value || !uuid.test(value)) {
    throw new BadRequestException({ code: "INVALID_ORGANIZATION_ID", message: "X-Argus-Organization-Id must be a valid UUID" });
  }
  return value;
});
