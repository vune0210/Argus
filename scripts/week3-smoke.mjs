import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Creates only its own local fixtures; never run against an external database/API.
if (!process.env.ARGUS_SMOKE_LOCAL) process.env.ARGUS_SMOKE_LOCAL = "true";
const databaseURL = process.env.DATABASE_URL ?? "postgres://argus:argus@127.0.0.1:5432/argus";
const base = process.env.ARGUS_API_URL ?? "http://127.0.0.1:4000";
for (const value of [databaseURL, base]) if (!["localhost", "127.0.0.1"].includes(new URL(value).hostname)) throw new Error("Smoke requires local API and database");
const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: databaseURL });
const regions = (process.env.ARGUS_SMOKE_REGIONS ?? "ap-southeast-1,ap-northeast-1,eu-central-1").split(",");
const target = process.env.ARGUS_SMOKE_TARGET ?? "http://test-target:8080/check";
const users = [`week3-a-${randomUUID()}`, `week3-b-${randomUUID()}`];
const organizations = [];
const abort = new AbortController();
const events = [];
let reading;
async function api(path, userIndex = 0, method = "GET", body) {
  return fetch(`${base}/api/v1/${path}`, { method, signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", "x-argus-user-id": users[userIndex], ...(organizations[userIndex] ? { "x-argus-organization-id": organizations[userIndex] } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function json(path, userIndex = 0, method = "GET", body) {
  const response = await api(path, userIndex, method, body);
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return response.json();
}
async function until(check, label) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(500); }
  throw new Error(`Timed out: ${label}`);
}
try {
  for (let i = 0; i < users.length; i++) organizations.push((await json("auth/bootstrap", i, "POST")).organization.id);
  const stream = await fetch(`${base}/api/v1/organizations/${organizations[0]}/events`, { headers: { "x-argus-user-id": users[0] }, signal: abort.signal });
  assert.equal(stream.status, 200);
  reading = (async () => {
    const decoder = new TextDecoder(); let buffer = "";
    for await (const chunk of stream.body) {
      buffer += decoder.decode(chunk, { stream: true }); let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("\n");
        if (data) events.push(JSON.parse(data));
      }
    }
  })().catch((error) => { if (!abort.signal.aborted) throw error; });
  // Observe rejection immediately while the main checks are running.
  reading.catch(() => undefined);
  const monitor = await json("monitors", 0, "POST", { name: "Week 3 day 1 smoke", intervalSeconds: 60, regions,
    config: { kind: "http", url: target, method: "GET", timeoutMs: 5000, expectedStatus: 200, maxRedirects: 5, maxResponseBytes: 1048576 } });
  const snapshot = await until(async () => {
    const value = await json(`monitors/${monitor.id}/snapshot`);
    return value.regions.length === regions.length && value.healthState === "HEALTHY" && value.regions.every((r) => r.outcome === "PASS" && r.heartbeat.status === "ALIVE") && value;
  }, "scheduled Go results and live heartbeat");
  assert.deepEqual(snapshot.regions.map((r) => r.region).sort(), [...regions].sort());
  assert.equal(new Set(snapshot.regions.map((r) => r.executionId)).size, 1);
  const executionId = snapshot.regions[0].executionId;
  const raw = await pool.query(`SELECT count(*)::int AS count FROM check_results c
    JOIN probe_results r ON r.id=c.result_id AND r.organization_id=c.organization_id AND r.received_at=c.received_at
    JOIN execution_targets t ON t.id=r.target_id WHERE t.execution_id=$1 AND t.organization_id=$2`, [executionId, organizations[0]]);
  assert.equal(raw.rows[0].count, regions.length, "Every accepted regional result must have exactly one raw copy");
  await until(() => events.some((e) => e.type === "execution.completed" && e.correlationId === executionId), "durable SSE completion");
  for (const region of regions) assert.equal(events.filter((e) => e.type === "probe.result_received" && e.correlationId === executionId && e.payload.region === region).length, 1);
  const foreign = await api(`monitors/${monitor.id}/snapshot`, 1); assert.equal(foreign.status, 404);
  const invalidProbe = await fetch(`${base}/api/v1/probe-leases`, { method: "POST", signal: AbortSignal.timeout(5000) }); assert.equal(invalidProbe.status, 401);
  const foreignStream = await fetch(`${base}/api/v1/organizations/${organizations[0]}/events`, { headers: { "x-argus-user-id": users[1] }, signal: AbortSignal.timeout(5000) }); assert.equal(foreignStream.status, 404);
  console.log(JSON.stringify({ status: "PASS", regions, executionId, checks: ["scheduled HTTP via real Go probe", "atomic snapshot/heartbeat and raw partition copy", "one SSE invalidation per regional result", "cross-tenant snapshot/SSE rejected", "unauthenticated probe rejected"] }, null, 2));
} finally {
  abort.abort();
  try { await reading; } finally {
    if (organizations.length) await pool.query("DELETE FROM organizations WHERE id=ANY($1)", [organizations]);
    await pool.query("DELETE FROM users WHERE id=ANY($1)", [users]);
    await pool.end();
  }
}
