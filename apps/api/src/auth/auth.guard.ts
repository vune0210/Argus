import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { ArgusRequest, Identity } from "../common/request";
import { readEnvironment } from "../config/environment";

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

function bearerToken(header: string | undefined): string | undefined {
  const [scheme, token] = header?.split(" ") ?? [];
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ArgusRequest>();
    const environment = readEnvironment();
    let identity: Identity;

    if (environment.authMode === "mock") {
      const id = request.header("x-argus-user-id") ?? "local-user";
      const email = request.header("x-argus-user-email") ?? "developer@argus.local";
      identity = { id, email };
    } else {
      const token = bearerToken(request.header("authorization"));
      if (!token) throw new UnauthorizedException({ code: "AUTH_REQUIRED", message: "A valid bearer token is required" });
      verifier ??= CognitoJwtVerifier.create({
        userPoolId: environment.cognitoUserPoolId!,
        clientId: environment.cognitoClientId!,
        tokenUse: "id",
      });
      try {
        const payload = await verifier.verify(token);
        if (typeof payload.email !== "string") throw new Error("ID token is missing email");
        identity = { id: payload.sub, email: payload.email };
      } catch {
        throw new UnauthorizedException({ code: "INVALID_TOKEN", message: "The identity token is invalid or expired" });
      }
    }

    request.identity = identity;
    return true;
  }
}
