import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

interface TokenResponse {
  id_token?: string;
  expires_in?: number;
  error?: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  const expectedState = request.cookies.get("argus_oidc_state")?.value;
  const verifier = request.cookies.get("argus_pkce_verifier")?.value;
  const domain = process.env.COGNITO_DOMAIN;
  const clientId = process.env.COGNITO_CLIENT_ID;
  const redirectUri = process.env.COGNITO_REDIRECT_URI;
  if (!state || !code || !expectedState || state !== expectedState || !verifier) {
    return NextResponse.json({ code: "INVALID_OIDC_STATE", message: "Authentication state is invalid or expired", traceId: randomUUID() }, { status: 400 });
  }
  if (!domain || !clientId || !redirectUri) {
    return NextResponse.json({ code: "AUTH_NOT_CONFIGURED", message: "Cognito is not configured", traceId: randomUUID() }, { status: 500 });
  }

  const tokenResponse = await fetch(new URL("/oauth2/token", domain), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    cache: "no-store",
  });
  const tokens = await tokenResponse.json() as TokenResponse;
  if (!tokenResponse.ok || !tokens.id_token) {
    return NextResponse.json({ code: "TOKEN_EXCHANGE_FAILED", message: "Cognito token exchange failed", traceId: randomUUID() }, { status: 401 });
  }

  const response = NextResponse.redirect(new URL("/monitors", request.url));
  response.cookies.set("argus_id_token", tokens.id_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.min(tokens.expires_in ?? 3600, 3600),
  });
  response.cookies.delete("argus_oidc_state");
  response.cookies.delete("argus_pkce_verifier");
  return response;
}
