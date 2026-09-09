import { NextResponse } from "next/server";

export async function GET(request: Request): Promise<NextResponse> {
  const mode = process.env.AUTH_MODE ?? process.env.NEXT_PUBLIC_AUTH_MODE ?? "mock";
  const domain = process.env.COGNITO_DOMAIN;
  const clientId = process.env.COGNITO_CLIENT_ID;
  const logoutUri = process.env.COGNITO_LOGOUT_URI;
  let destination = new URL("/login", request.url);
  if (mode === "cognito" && domain && clientId && logoutUri) {
    destination = new URL("/logout", domain);
    destination.search = new URLSearchParams({ client_id: clientId, logout_uri: logoutUri }).toString();
  }
  const response = NextResponse.redirect(destination);
  response.cookies.delete("argus_mock_user");
  response.cookies.delete("argus_id_token");
  response.cookies.delete("argus_oidc_state");
  response.cookies.delete("argus_pkce_verifier");
  return response;
}
