import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

if (process.env.ARGUS_SOAK_LOCAL !== "true") throw new Error("Set ARGUS_SOAK_LOCAL=true for isolated local services");

const databaseURL = process.env.DATABASE_URL ?? "postgres://argus:argus@127.0.0.1:5432/argus";
const apiURL = process.env.ARGUS_API_URL ?? "http://127.0.0.1:4000";
for (const value of [databaseURL, apiURL]) {
  if (!["localhost", "127.0.0.1"].includes(new URL(value).hostname)) throw new Error("Soak requires a local API and database");
}

const durationMs = Number(process.env.ARGUS_SOAK_DURATION_MS ?? 4 * 60 * 60 * 1000);
if (!Number.isInteger(durationMs) || durationMs < 60_000 || durationMs > 24 * 60 * 60 * 1000) {
  throw new Error("ARGUS_SOAK_DURATION_MS must be an integer from 60000 to 86400000");
}

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: databaseURL });
const regions = ["ap-southeast-1", "ap-northeast-1", "eu-central-1"];
const target = process.env.ARGUS_SOAK_TARGET ?? "http://host.docker.internal:8080/check";
const user = `soak-${randomUUID()}`;
const abort = new AbortController();
const events = [];
let organizationId;
let reading;

async function request(path, method = "GET", body) {
  const response = await fetch(`${apiURL}/api/v1/${path}`, {
    method,
    signal: AbortSignal.timeout(10_000),
    headers: {
      "content-type": "application/json",
      "x-argus-user-id": user,
      ...(organizationId ? { "x-argus-organization-id": organizationId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function until(check, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(1_000);
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  organizationId = (await request("auth/bootstrap", "POST")).organization.id;
  const stream = await fetch(`${apiURL}/api/v1/organizations/${organizationId}/events`, {
    headers: { "x-argus-user-id": user },
    signal: abort.signal,
  });
  assert.equal(stream.status, 200);
  reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("\n");
        if (data) events.push(JSON.parse(data));
      }
    }
  })().catch((error) => {
    if (!abort.signal.aborted) throw error;
  });
  reading.catch(() => undefined);

  const monitor = await request("monitors", "POST", {
    name: `Week 3 soak ${new Date().toISOString()}`,
    intervalSeconds: 60,
    regions,
    config: { kind: "http", url: target, method: "GET", timeoutMs: 5_000, expectedStatus: 200, maxRedirects: 5, maxResponseBytes: 1_048_576 },
  });
  const startedAt = Date.now();
  await until(async () => {
    const snapshot = await request(`monitors/${monitor.id}/snapshot`);
    return snapshot.healthState === "HEALTHY"
      && snapshot.regions.length === regions.length
      && snapshot.regions.every((region) => region.outcome === "PASS" && region.heartbeat.status === "ALIVE");
  }, "first healthy three-region snapshot");

  while (Date.now() - startedAt < durationMs) {
    const snapshot = await request(`monitors/${monitor.id}/snapshot`);
    assert.equal(snapshot.regions.length, regions.length);
    assert.ok(snapshot.regions.every((region) => region.heartbeat.status === "ALIVE"), "A regional heartbeat became stale during soak");
    await delay(Math.min(5_000, Math.max(1, durationMs - (Date.now() - startedAt))));
  }

  await until(async () => {
    const result = await pool.query("SELECT count(*)::int AS count FROM executions WHERE monitor_id=$1 AND status NOT IN ('COMPLETED','EXPIRED')", [monitor.id]);
    return result.rows[0].count === 0;
  }, "all soak executions to become terminal");

  const rows = (await pool.query(`
    SELECT e.id,e.status,e.observation,max(t.attempts)::int AS max_attempts,
      count(DISTINCT t.id)::int AS targets,
      count(DISTINCT r.id)::int AS results,
      count(DISTINCT c.result_id)::int AS raw_results
    FROM executions e
    JOIN execution_targets t ON t.execution_id=e.id AND t.organization_id=e.organization_id
    LEFT JOIN probe_results r ON r.target_id=t.id AND r.organization_id=t.organization_id
    LEFT JOIN check_results c ON c.result_id=r.id AND c.organization_id=r.organization_id AND c.received_at=r.received_at
    WHERE e.monitor_id=$1 AND e.organization_id=$2 AND e.kind='SCHEDULED'
    GROUP BY e.id,e.status,e.observation,e.scheduled_at
    ORDER BY e.scheduled_at`, [monitor.id, organizationId])).rows;
  assert.ok(rows.length > 0, "Soak produced no scheduled executions");
  for (const row of rows) {
    assert.equal(row.status, "COMPLETED", `Execution ${row.id} did not complete`);
    assert.equal(row.observation, "QUORUM_PASS", `Execution ${row.id} was not a clean pass`);
    assert.equal(row.targets, 3, `Execution ${row.id} did not have three targets`);
    assert.equal(row.results, 3, `Execution ${row.id} did not have three canonical results`);
    assert.equal(row.raw_results, 3, `Execution ${row.id} did not have three raw results`);
  }
  const ids = new Set(rows.map((row) => row.id));
  await until(() => [...ids].every((id) =>
    events.some((event) => event.type === "execution.completed" && event.correlationId === id)
    && events.filter((event) => event.type === "probe.result_received" && event.correlationId === id).length >= 3),
  "all soak SSE events");
  for (const id of ids) {
    assert.equal(events.filter((event) => event.type === "execution.completed" && event.correlationId === id).length, 1, `Execution ${id} completion event count`);
    assert.equal(events.filter((event) => event.type === "probe.result_received" && event.correlationId === id).length, 3, `Execution ${id} result event count`);
  }
  await until(async () => {
    const result = await pool.query("SELECT count(*)::int AS count FROM outbox_events WHERE organization_id=$1 AND published_at IS NULL", [organizationId]);
    return result.rows[0].count === 0;
  }, "soak outbox to drain");
  const pending = (await pool.query("SELECT count(*)::int AS count FROM outbox_events WHERE organization_id=$1 AND published_at IS NULL", [organizationId])).rows[0].count;
  assert.equal(pending, 0, "Soak left unpublished outbox events");

  const finalSnapshot = await request(`monitors/${monitor.id}/snapshot`);
  assert.ok(finalSnapshot.regions.every((region) => region.outcome === "PASS" && region.heartbeat.status === "ALIVE"));
  console.log(JSON.stringify({
    status: "PASS",
    durationMs,
    executions: rows.length,
    firstExecutionId: rows[0].id,
    lastExecutionId: rows.at(-1).id,
    maxAttempts: Math.max(...rows.map((row) => row.max_attempts)),
    pendingOutbox: pending,
    checks: ["three targets/results/raw copies per execution", "one completion and three result SSE events", "regional heartbeat remained alive", "outbox drained"],
  }, null, 2));
} finally {
  abort.abort();
  try { await reading; } finally {
    if (organizationId) await pool.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    await pool.query("DELETE FROM users WHERE id=$1", [user]);
    await pool.end();
  }
}
