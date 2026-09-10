import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

if (!process.env.ARGUS_SMOKE_LOCAL) process.env.ARGUS_SMOKE_LOCAL = "true";
const db = process.env.DATABASE_URL ?? "postgres://argus:argus@127.0.0.1:5432/argus";
if (!["localhost", "127.0.0.1"].includes(new URL(db).hostname)) throw new Error("Local test database required");
const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const pool = new (require("pg").Pool)({ connectionString: db });
const suffix = randomUUID().slice(0, 8), region = `recovery-${suffix}`, user = `recovery-${suffix}`;
const probes = ["original", "replacement"].map(kind => ({ id: `day2-${kind}-${suffix}`, token: "", container: `argus-day2-${kind}-${suffix}` }));
for (const probe of probes) probe.token = `argp_${probe.id}.${randomUUID().replaceAll("-", "")}`;
const started = [];
let org, requests = 0;
const server = createServer((_req, res) => {
  requests++;
  const finish = () => res.writeHead(200).end("ok");
  if (requests === 1) setTimeout(finish, 20_000).unref(); else finish();
});
const docker = (args, env = process.env) => execFileSync("docker", args, { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 });
async function api(path, method = "GET", body) {
  const response = await fetch(`http://127.0.0.1:4000/api/v1/${path}`, { method, signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/json", "x-argus-user-id": user, ...(org ? { "x-argus-organization-id": org } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`); return response.json();
}
async function until(check, name) {
  const end = Date.now() + 90_000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(300); }
  throw new Error(`Timed out: ${name}`);
}
function start(probe) {
  docker(["run", "-d", "--pull=never", "--name", probe.container, "--read-only",
    "-e", "ARGUS_ENV=test", "-e", "ARGUS_CONTROL_PLANE_URL=http://host.docker.internal:4000",
    "-e", `ARGUS_PROBE_ID=${probe.id}`, "-e", `ARGUS_REGION=${region}`, "-e", "ARGUS_TOKEN",
    "-e", "ARGUS_ALLOW_PRIVATE_TARGETS=true", "-e", "ARGUS_CONCURRENCY=1", "argus-probe:week3-day2", "run"], { ...process.env, ARGUS_TOKEN: probe.token });
  started.push(probe.container);
}
try {
  server.listen(0, "0.0.0.0"); await once(server, "listening");
  org = (await api("auth/bootstrap", "POST")).organization.id;
  for (const probe of probes) await pool.query("INSERT INTO probe_agents(id,region,token_digest,is_development) VALUES($1,$2,$3,true)",
    [probe.id, region, createHmac("sha256", process.env.PROBE_TOKEN_HMAC_KEY ?? "local-development-hmac-key-not-for-production").update(probe.token).digest("hex")]);
  start(probes[0]);
  const monitor = await api("monitors", "POST", { name: "Day2 real probe crash", intervalSeconds: 60, regions: [region],
    config: { kind: "http", url: `http://host.docker.internal:${server.address().port}/check`, method: "GET", timeoutMs: 30_000, expectedStatus: 200, maxRedirects: 0, maxResponseBytes: 1024 } });
  const owned = await until(async () => {
    const row = (await pool.query("SELECT t.*,e.monitor_version,e.scheduled_at FROM execution_targets t JOIN executions e ON e.id=t.execution_id WHERE e.monitor_id=$1 AND t.status='LEASED'", [monitor.id])).rows[0];
    return requests > 0 && row;
  }, "original probe holds and executes lease");
  docker(["kill", probes[0].container]);
  start(probes[1]);
  const completed = await until(async () => {
    const row = (await pool.query("SELECT * FROM execution_targets WHERE id=$1 AND status='COMPLETED'", [owned.id])).rows[0]; return row;
  }, "natural 45-second lease reclaim by another real probe");
  assert.equal(completed.probe_id, probes[1].id); assert.equal(completed.attempts, 2);
  const oldResponse = await fetch(`http://127.0.0.1:4000/api/v1/probe-leases/${owned.lease_id}/result`, {
    method: "POST", signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${probes[0].token}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: "0.1", executionId: owned.execution_id, organizationId: org, monitorId: monitor.id,
      monitorVersion: owned.monitor_version, probeId: probes[0].id, region, startedAt: owned.scheduled_at, completedAt: owned.scheduled_at, durationMs: 0, outcome: "PASS", http: { statusCode: 200, responseBytes: 2 } }) });
  assert.equal(oldResponse.status, 410);
  const counts = await pool.query("SELECT count(*)::int AS n FROM check_results c JOIN probe_results r ON r.id=c.result_id WHERE r.target_id=$1", [owned.id]);
  assert.equal(counts.rows[0].n, 1);
  const snapshot = await api(`monitors/${monitor.id}/snapshot`); assert.equal(snapshot.regions[0].outcome, "PASS");
  console.log(JSON.stringify({ status: "PASS", checks: ["real container killed during HTTP check", "lease naturally reclaimed by different probe", "old owner HTTP 410", "one raw result", "snapshot recovered"] }));
} finally {
  for (const name of started) docker(["rm", "-f", name]);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (org) await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
  await pool.query("DELETE FROM users WHERE id=$1", [user]);
  await pool.query("DELETE FROM probe_agents WHERE id=ANY($1)", [probes.map(p => p.id)]);
  const redis = require("redis").createClient({ url: "redis://127.0.0.1:6379" });
  redis.on("error", () => {});
  try { await redis.connect(); await redis.del([`argus:v1:probe-jobs:${region}`, `argus:v1:probe-jobs:${region}:dlq`]); } finally { if (redis.isOpen) redis.destroy(); await pool.end(); }
}
