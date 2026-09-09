import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

const secure = process.env.NODE_ENV === "production";
const cookie = { httpOnly: true, sameSite: "lax" as const, secure, path: "/" };

export async function GET(request: Request): Promise<NextResponse> {
  const authMode = process.env.AUTH_MODE ?? process.env.NEXT_PUBLIC_AUTH_MODE ?? "mock";
  if (authMode === "mock") {
    if (!["development", "test"].includes(process.env.NODE_ENV ?? "development")) {
      return NextResponse.json({ code: "UNSAFE_AUTH_MODE", message: "Mock auth is disabled", traceId: crypto.randomUUID() }, { status: 500 });
    }
    const response = NextResponse.redirect(new URL("/monitors", request.url));
    response.cookies.set("argus_mock_user", "1", { ...cookie, maxAge: 8 * 60 * 60 });
    return response;
  }

  const domain = process.env.COGNITO_DOMAIN;
  const clientId = process.env.COGNITO_CLIENT_ID;
  const redirectUri = process.env.COGNITO_REDIRECT_URI;
  if (!domain || !clientId || !redirectUri) {
    return NextResponse.json({ code: "AUTH_NOT_CONFIGURED", message: "Cognito is not configured", traceId: crypto.randomUUID() }, { status: 500 });
  }
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URL("/oauth2/authorize", domain);
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid email",
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  }).toString();
  const response = NextResponse.redirect(authorization);
  response.cookies.set("argus_oidc_state", state, { ...cookie, maxAge: 600 });
  response.cookies.set("argus_pkce_verifier", verifier, { ...cookie, maxAge: 600 });
  return response;
}
