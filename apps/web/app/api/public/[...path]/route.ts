import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

async function publicProxy(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const base = process.env.ARGUS_API_URL ?? "http://localhost:4000";
  const target = new URL(`api/public/${path.join("/")}`, base.endsWith("/") ? base : `${base}/`);

  if (
    target.origin !== new URL(base).origin ||
    !target.pathname.startsWith("/api/public/v1/") ||
    path.some((part) => part === ".." || part.includes("\\"))
  ) {
    return NextResponse.json(
      { code: "INVALID_PROXY_PATH", message: "Invalid public API path", traceId: randomUUID() },
      { status: 400 },
    );
  }

  target.search = request.nextUrl.search;

  try {
    const upstream = await fetch(target, {
      method: "GET",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: request.signal,
    });

    const responseHeaders = new Headers();
    const contentType = upstream.headers.get("content-type");
    const cacheControl = upstream.headers.get("cache-control");
    if (contentType) responseHeaders.set("content-type", contentType);
    if (cacheControl) responseHeaders.set("cache-control", cacheControl);

    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return NextResponse.json(
      { code: "UPSTREAM_UNAVAILABLE", message: "Argus Public API is unavailable", traceId: randomUUID() },
      { status: 502 },
    );
  }
}

export const GET = publicProxy;
