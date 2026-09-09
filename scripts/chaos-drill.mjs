import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Pool } = require("pg");
if (process.env.ARGUS_CHAOS_LOCAL !== "true") throw new Error("Set ARGUS_CHAOS_LOCAL=true for the local Compose stack only");
const databaseURL = process.env.DATABASE_URL ?? "postgres://argus:argus@127.0.0.1:5432/argus";
if (!["localhost", "127.0.0.1"].includes(new URL(databaseURL).hostname)) throw new Error("Chaos drill requires a local test database");
const pool = new Pool({ connectionString: databaseURL });
const user = `chaos-${randomUUID()}`;
let org;
const abort = new AbortController();
const events = new Set();
const compose = (...args) => execFileSync("docker", ["compose", ...args], { stdio: "pipe", timeout: 60_000 });
async function api(path, method = "GET", body) {
  const response = await fetch(`http://127.0.0.1:4000/api/v1/${path}`, { method,
    headers: { "Content-Type": "application/json", "x-argus-user-id": user, ...(org ? { "x-argus-organization-id": org } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function until(fn, label, timeout = 40_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(500); }
  throw new Error(`Timed out: ${label}`);
}
async function monitor(name) {
  const m = await api("monitors", "POST", { name, intervalSeconds: 60, regions: ["ap-southeast-1", "ap-northeast-1", "eu-central-1"],
    config: { kind: "http", url: "http://test-target:8080/healthy", method: "GET", timeoutMs: 2000, expectedStatus: 200, maxRedirects: 5, maxResponseBytes: 1048576 } });
  await until(async () => (await api(`monitors/${m.id}`)).healthState === "HEALTHY", "initial health");
  return m;
}
async function trigger(id, finish = true) {
  const before = (await api(`monitors/${id}/executions`)).items[0]?.id;
  await pool.query("UPDATE monitors SET next_run_at=now() WHERE id=$1 AND organization_id=$2", [id,org]);
  const e = await until(async () => { const e = (await api(`monitors/${id}/executions`)).items[0]; return e?.id !== before && e; }, "new scheduled execution");
  return finish ? until(async () => { const value = await api(`executions/${e.id}`); return value.status === "COMPLETED" && value; }, "execution completion") : e;
}
try {
  org = (await api("auth/bootstrap", "POST")).organization.id;
  const stream = await fetch(`http://127.0.0.1:4000/api/v1/organizations/${org}/events`, { headers: { "x-argus-user-id": user }, signal: abort.signal });
  assert.equal(stream.status,200);
  const reading = (async () => { let text = ""; for await (const chunk of stream.body) {
    text += new TextDecoder().decode(chunk); let split;
    while ((split=text.indexOf("\n\n"))>=0) { const frame=text.slice(0,split);text=text.slice(split+2);const type=frame.match(/^event: (.+)$/m)?.[1];if(type)events.add(type); }
  } })().catch(() => undefined);
  const missing = await monitor("Chaos: missing probe");
  compose("stop","-t","3","probe-frankfurt");
  const partial = await trigger(missing.id,false);
  await until(async () => (await api(`executions/${partial.id}`)).targets.filter((t) => t.result).length === 2,"two region results");
  await pool.query("UPDATE executions SET deadline_at=clock_timestamp() WHERE id=$1",[partial.id]);
  await until(async () => (await api(`executions/${partial.id}`)).status === "COMPLETED","deadline finalization");
  assert.equal((await api(`executions/${partial.id}`)).observation,"INSUFFICIENT_RESULTS");
  assert.equal((await api("incidents")).items.length,0);
  await api(`monitors/${missing.id}`,"DELETE");
  compose("start","probe-frankfurt");
  console.log("PASS: missing region produces insufficient results without an incident");

  const outage = await monitor("Chaos: outage and recovery");
  compose("stop","-t","3","test-target");
  await trigger(outage.id); assert.equal((await api(`monitors/${outage.id}`)).healthState,"PENDING_DOWN");
  await trigger(outage.id); assert.equal((await api(`monitors/${outage.id}`)).healthState,"DOWN");
  const open = (await api("incidents")).items; assert.equal(open.length,1);
  const manual = await api(`monitors/${outage.id}/run`,"POST");
  await until(async () => (await api(`executions/${manual.id}`)).status === "COMPLETED","diagnostic completion");
  assert.equal((await api(`monitors/${outage.id}`)).healthState,"DOWN");
  compose("start","test-target");
  await trigger(outage.id); assert.equal((await api(`monitors/${outage.id}`)).healthState,"PENDING_RECOVERY");
  await trigger(outage.id); assert.equal((await api(`monitors/${outage.id}`)).healthState,"HEALTHY");
  const resolved = await api(`incidents/${open[0].id}`); assert.ok(resolved.resolvedAt); assert.equal(resolved.events.length,2);
  console.log("PASS: two failures open one incident; diagnostic preserves health; two passes resolve it");

  compose("stop","-t","3","redis");
  const queued = await trigger(outage.id,false);
  assert.equal((await api(`executions/${queued.id}`)).status,"QUEUED");
  compose("start","redis");
  const completed = await until(async () => { const e=await api(`executions/${queued.id}`);return e.status === "COMPLETED" && e; },"Redis recovery",70_000);
  assert.equal(completed.targets.length,3); assert.equal(completed.targets.filter((t) => t.result).length,3);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM probe_results WHERE target_id IN (SELECT id FROM execution_targets WHERE execution_id=$1)",[queued.id])).rows[0].count,3);
  for (const type of ["execution.completed","monitor.health_changed","incident.opened","incident.resolved"]) await until(() => events.has(type),`SSE ${type}`);
  console.log("PASS: Redis restart drains durable work without duplicate results; all four SSE events received");
  abort.abort(); await reading;
} finally {
  abort.abort();
  compose("start","redis","test-target","probe-frankfurt");
  if(org) await pool.query("DELETE FROM organizations WHERE id=$1",[org]);
  await pool.query("DELETE FROM users WHERE id=$1",[user]);
  await pool.end();
}
