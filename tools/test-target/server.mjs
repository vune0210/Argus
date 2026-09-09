import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function createTarget({ controlEnabled = false } = {}) {
let mode = "healthy";
let slowMs = 1500;
return createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  response.setHeader("content-type", "application/json");
  if (url.pathname === "/__control" && controlEnabled) {
    if (request.method !== "POST") { response.writeHead(405, { allow: "POST" }).end(); return; }
    const next = url.searchParams.get("mode");
    const delay = Number(url.searchParams.get("delayMs") ?? 1500);
    if (!["healthy", "slow", "down"].includes(next) || !Number.isInteger(delay) || delay < 0 || delay > 10_000) {
      response.writeHead(400).end(JSON.stringify({ status: "invalid_control" })); return;
    }
    mode = next; slowMs = delay;
    response.writeHead(200).end(JSON.stringify({ mode, delayMs: slowMs })); return;
  }
  if (url.pathname === "/check") {
    const current = mode;
    if (current === "slow") await new Promise((resolve) => setTimeout(resolve, slowMs));
    response.writeHead(current === "down" ? 503 : 200).end(JSON.stringify({ status: current })); return;
  }
  if (url.pathname === "/healthy") {
    response.writeHead(200).end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (url.pathname === "/slow") {
    const delay = Math.min(Math.max(Number(url.searchParams.get("ms") ?? 1500), 0), 10_000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    response.writeHead(200).end(JSON.stringify({ status: "ok", delay }));
    return;
  }
  if (url.pathname === "/error") {
    response.writeHead(503).end(JSON.stringify({ status: "unavailable" }));
    return;
  }
  if (url.pathname === "/redirect") {
    response.writeHead(302, { location: "/healthy" }).end();
    return;
  }
  if (url.pathname === "/keyword/match") {
    response.writeHead(200, { "content-type": "text/plain" }).end("Service is running ARGUS_KEYWORD_MATCH_TARGET_OK perfectly");
    return;
  }
  if (url.pathname === "/keyword/mismatch") {
    response.writeHead(200, { "content-type": "text/plain" }).end("Service is running but contains NO_MATCH_TARGET here");
    return;
  }
  if (url.pathname === "/keyword/case") {
    response.writeHead(200, { "content-type": "text/plain" }).end("ARGUS_Healthy_Target");
    return;
  }
  response.writeHead(404).end(JSON.stringify({ status: "not_found" }));
});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const port = Number(process.env.PORT ?? 8080);
const server = createTarget({ controlEnabled: process.env.ARGUS_TEST_CONTROL === "true" });
server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", service: "argus-test-target", event: "started", port }));
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
}
