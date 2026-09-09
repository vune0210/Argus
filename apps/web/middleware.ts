import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest): NextResponse {
  const mockAllowed = ["development", "test"].includes(process.env.NODE_ENV ?? "development")
    && (process.env.AUTH_MODE ?? process.env.NEXT_PUBLIC_AUTH_MODE ?? "mock") === "mock";
  const authenticated = (mockAllowed && request.cookies.has("argus_mock_user")) || request.cookies.has("argus_id_token");
  if (!authenticated) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}

export const config = { matcher: ["/monitors/:path*", "/incidents/:path*", "/status-pages/:path*"] };
