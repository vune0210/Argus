import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

async function proxy(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const base = process.env.ARGUS_API_URL ?? "http://localhost:4000";
  const target = new URL(path.join("/"), base.endsWith("/") ? base : `${base}/`);
  if (target.origin !== new URL(base).origin || !target.pathname.startsWith("/api/v1/") || path.some((part) => part === ".." || part.includes("\\"))) {
    return NextResponse.json({ code: "INVALID_PROXY_PATH", message: "Invalid API path", traceId: randomUUID() }, { status: 400 });
  }
  target.search = request.nextUrl.search;
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  const organizationId = request.headers.get("x-argus-organization-id");
  if (contentType) headers.set("content-type", contentType);
  if (organizationId) headers.set("x-argus-organization-id", organizationId);
  const lastEventId = request.headers.get("last-event-id");
  if (lastEventId) headers.set("Last-Event-ID", lastEventId);

  const identityToken = request.cookies.get("argus_id_token")?.value;
  const mockIdentity = request.cookies.has("argus_mock_user");
  if (identityToken) {
    headers.set("authorization", `Bearer ${identityToken}`);
  } else if (mockIdentity && ["development", "test"].includes(process.env.NODE_ENV ?? "development")) {
    headers.set("x-argus-user-id", process.env.MOCK_USER_ID ?? "local-user");
    headers.set("x-argus-user-email", process.env.MOCK_USER_EMAIL ?? "developer@argus.local");
  } else {
    return NextResponse.json({ code: "AUTH_REQUIRED", message: "Sign in is required", traceId: randomUUID() }, { status: 401 });
  }

  try {
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
    const upstream = await fetch(target, { method: request.method, headers, body, cache: "no-store", redirect: "manual", signal: request.signal });
    const responseHeaders = new Headers();
    const upstreamType = upstream.headers.get("content-type");
    const traceId = upstream.headers.get("x-trace-id");
    if (upstreamType) responseHeaders.set("content-type", upstreamType);
    if (traceId) responseHeaders.set("x-trace-id", traceId);
    if (upstream.status === 204) return new Response(null, { status: 204, headers: responseHeaders });
    if (upstreamType?.includes("text/event-stream")) {
      responseHeaders.set("Cache-Control", "no-cache, no-transform");
      responseHeaders.set("X-Accel-Buffering", "no");
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return NextResponse.json({ code: "UPSTREAM_UNAVAILABLE", message: "Argus API is unavailable", traceId: randomUUID() }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
