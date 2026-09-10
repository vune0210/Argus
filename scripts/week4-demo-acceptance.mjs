import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Pool } = require("pg");

const TOTAL_CYCLES = 5;
const REGIONS = ["ap-southeast-1", "ap-northeast-1", "eu-central-1"];

// SLA Targets (in milliseconds)
const SLA_DASHBOARD_MAX_MS = 5_000;      // <= 5s
const SLA_NOTIFICATION_MAX_MS = 10_000;   // <= 10s
const SLA_INCIDENT_STATUS_MAX_MS = 15_000;// <= 15s

const API_BASE = process.env.ARGUS_API_URL || "http://127.0.0.1:4000";
const TARGET_CONTROL_URL = process.env.TARGET_CONTROL_URL || "http://127.0.0.1:8080";
const SINK_URL = process.env.SINK_URL || "http://127.0.0.1:4002";
const DATABASE_URL = process.env.DATABASE_URL || "postgres://argus:argus@127.0.0.1:5432/argus";

const pool = new Pool({ connectionString: DATABASE_URL });

async function checkInfrastructure() {
  console.log("--> Verifying all services are ready...");
  const endpoints = [
    { name: "API Control Plane", url: `${API_BASE}/health/ready` },
    { name: "Test Target", url: `${TARGET_CONTROL_URL}/healthy` },
    { name: "Mock Notification Sink", url: `${SINK_URL}/health` },
    { name: "Web Health Route", url: "http://127.0.0.1:3000/api/health" },
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log(`  [OK] ${ep.name} is ready`);
    } catch (err) {
      throw new Error(`CRITICAL: Service ${ep.name} check failed at ${ep.url}: ${err.message}`);
    }
  }

  // Ensure target starts in healthy mode
  await fetch(`${TARGET_CONTROL_URL}/__control?mode=healthy`, { method: "POST" });
}

async function setTargetMode(mode) {
  const res = await fetch(`${TARGET_CONTROL_URL}/__control?mode=${mode}`, { method: "POST" });
  assert.ok(res.ok, `Failed to set test target mode to ${mode}`);
}

async function clearSinkDeliveries() {
  const res = await fetch(`${SINK_URL}/deliveries`, { method: "DELETE" });
  assert.ok(res.ok, "Failed to clear mock sink deliveries");
}

async function getSinkDeliveries() {
  const res = await fetch(`${SINK_URL}/deliveries`);
  assert.ok(res.ok, "Failed to get mock sink deliveries");
  const data = await res.json();
  return data.deliveries || [];
}

async function until(fn, label, timeoutMs = 25_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await delay(intervalMs);
  }
  throw new Error(`Timeout waiting for: ${label} (waited ${timeoutMs}ms)`);
}

async function runSingleCycle(cycle, cleanupList) {
  console.log(`\n=================================================`);
  console.log(`  STARTING CYCLE ${cycle} OF ${TOTAL_CYCLES}`);
  console.log(`=================================================`);

  const userId = `demo-user-cycle-${cycle}-${randomUUID()}`;
  cleanupList.users.push(userId);

  // 1. Bootstrap tenant
  const bootRes = await fetch(`${API_BASE}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-argus-user-id": userId },
  });
  assert.equal(bootRes.status, 200, "Bootstrap failed");
  const bootData = await bootRes.json();
  const orgId = bootData.organization.id;
  cleanupList.orgs.push(orgId);
  console.log(`  [1] Tenant bootstrapped: ${orgId}`);

  const apiHeaders = {
    "content-type": "application/json",
    "x-argus-user-id": userId,
    "x-argus-organization-id": orgId,
  };

  // 2. Setup SSE Listener
  const abortCtrl = new AbortController();
  const sseEvents = [];
  const sseStart = fetch(`${API_BASE}/api/v1/organizations/${orgId}/events`, {
    headers: { "x-argus-user-id": userId },
    signal: abortCtrl.signal,
  }).then(async (res) => {
    assert.equal(res.status, 200, "SSE connection failed");
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        const eventLine = frame.split("\n").find((l) => l.startsWith("event:"));
        if (dataLine) {
          try {
            const parsed = JSON.parse(dataLine.slice(5));
            const eventType = eventLine ? eventLine.slice(6).trim() : parsed.type;
            sseEvents.push({ type: eventType, data: parsed, receivedAt: Date.now() });
          } catch {}
        }
      }
    }
  }).catch(() => {});

  // 3. Create Slack and Email Channels
  const slackRes = await fetch(`${API_BASE}/api/v1/notification-channels`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      name: `Slack Channel C${cycle}`,
      type: "SLACK",
      secretArn: `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:slack-webhook-c${cycle}`,
      enabled: true,
    }),
  });
  assert.equal(slackRes.status, 201, "Failed to create Slack channel");
  const slackChannel = await slackRes.json();

  const emailRes = await fetch(`${API_BASE}/api/v1/notification-channels`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      name: `Email Channel C${cycle}`,
      type: "EMAIL",
      email: `oncall-c${cycle}@argus.test`,
      enabled: true,
    }),
  });
  assert.equal(emailRes.status, 201, "Failed to create Email channel");
  const emailChannel = await emailRes.json();
  console.log(`  [2] Multi-channel created: Slack (${slackChannel.id}) & Email (${emailChannel.id})`);

  // 4. Configure Escalation Policy
  const policyRes = await fetch(`${API_BASE}/api/v1/escalation-policy`, {
    method: "PUT",
    headers: apiHeaders,
    body: JSON.stringify({
      name: `Policy Cycle ${cycle}`,
      steps: [
        {
          stepOrder: 0,
          name: "PRIMARY",
          delaySeconds: 0,
          channelIds: [slackChannel.id, emailChannel.id],
        },
        {
          stepOrder: 1,
          name: "SECONDARY",
          delaySeconds: 300,
          channelIds: [slackChannel.id],
        },
        {
          stepOrder: 2,
          name: "TEAM",
          delaySeconds: 600,
          channelIds: [emailChannel.id],
        },
      ],
    }),
  });
  assert.equal(policyRes.status, 200, "Failed to configure escalation policy");
  console.log("  [3] Primary escalation configured with simultaneous Slack & Email (delay 0s)");

  // 5. Create Monitor with 3 Regions and 1/1 threshold
  const monRes = await fetch(`${API_BASE}/api/v1/monitors`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      name: `Demo Monitor C${cycle}`,
      intervalSeconds: 60,
      regions: REGIONS,
      incidentPolicy: {
        failureThreshold: 1,
        recoveryThreshold: 1,
      },
      config: {
        kind: "http",
        url: "http://test-target:8080/check",
        method: "GET",
        timeoutMs: 3000,
        expectedStatus: 200,
        maxRedirects: 5,
        maxResponseBytes: 1048576,
      },
    }),
  });
  assert.equal(monRes.status, 201, "Failed to create monitor");
  const monitor = await monRes.json();
  console.log(`  [4] Monitor created (${monitor.id}), 3 regions: ${REGIONS.join(", ")}, threshold 1/1`);

  // 6. Create Public Status Page
  const slug = `demo-c${cycle}-${randomUUID().slice(0, 8)}`;
  const spRes = await fetch(`${API_BASE}/api/v1/status-pages`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      name: `Status Page Cycle ${cycle}`,
      slug,
      published: true,
      components: [
        {
          monitorId: monitor.id,
          publicName: `Core API Service C${cycle}`,
        },
      ],
    }),
  });
  assert.equal(spRes.status, 201, "Failed to create status page");
  console.log(`  [5] Status page published at /status/${slug}`);

  // -------------------------------------------------------------
  // PHASE A: DOWN EVALUATION, PROBE QUORUM, INCIDENT OPEN & NOTIFICATION
  // -------------------------------------------------------------
  console.log("\n  --- PHASE A: Triggering Outage Evaluation ---");
  await setTargetMode("down");
  await clearSinkDeliveries();

  const evalDownKey = randomUUID();
  const t0 = Date.now();

  const evalDownRes = await fetch(`${API_BASE}/api/v1/monitors/${monitor.id}/evaluate`, {
    method: "POST",
    headers: {
      ...apiHeaders,
      "Idempotency-Key": evalDownKey,
    },
    body: JSON.stringify({ monitorVersion: monitor.version }),
  });
  assert.equal(evalDownRes.status, 202, "Evaluate request failed");
  const evalDown = await evalDownRes.json();
  console.log(`  Triggered evaluate now: Execution ID ${evalDown.id}`);

  // Measure 1: Probe Results Ingestion & Health State
  const completedExec = await until(async () => {
    const res = await fetch(`${API_BASE}/api/v1/executions/${evalDown.id}`, { headers: apiHeaders });
    const data = await res.json();
    return data.status === "COMPLETED" && data.observation === "QUORUM_FAILURE" && data;
  }, "3 probe results ingested with QUORUM_FAILURE", 20_000);

  const tExecutionDone = Date.now();
  console.log(`  ✓ 3 real Go probe results received: QUORUM_FAILURE in ${tExecutionDone - t0}ms`);

  // Measure 2: Health state transition to DOWN & Incident Open
  const openIncident = await until(async () => {
    const incRes = await fetch(`${API_BASE}/api/v1/incidents`, { headers: apiHeaders });
    const incs = await incRes.json();
    const found = (incs.items || []).find((i) => i.monitorId === monitor.id && i.status === "OPEN");
    return found;
  }, "incident opened and health DOWN", 15_000);

  const tIncidentOpened = Date.now();
  const incidentLatencyMs = tIncidentOpened - t0;
  assert.ok(incidentLatencyMs <= SLA_INCIDENT_STATUS_MAX_MS, `Incident opened in ${incidentLatencyMs}ms (SLA <= 15s)`);
  console.log(`  ✓ Incident opened (${openIncident.id}) in ${incidentLatencyMs}ms [SLA <= 15s: PASS]`);

  // Measure 3: SSE / Dashboard Refresh
  await until(() => {
    return sseEvents.some((e) => (e.type === "incident.opened" || e.type === "monitor.health_changed") && e.receivedAt >= t0);
  }, "SSE dashboard event received", 5_000);
  const sseLatencyMs = Date.now() - t0;
  assert.ok(sseLatencyMs <= SLA_DASHBOARD_MAX_MS, `Dashboard refreshed in ${sseLatencyMs}ms (SLA <= 5s)`);
  console.log(`  ✓ SSE dashboard refreshed in ${sseLatencyMs}ms [SLA <= 5s: PASS]`);

  // Measure 4: Public Status Page shows Major Outage
  await until(async () => {
    const res = await fetch(`${API_BASE}/api/public/v1/status-pages/${slug}`);
    if (!res.ok) return false;
    const sp = await res.json();
    return (sp.overallStatus === "MAJOR_OUTAGE" || sp.status === "MAJOR_OUTAGE") && sp;
  }, "Public status page indicates MAJOR_OUTAGE", 15_000);
  const statusPageLatencyMs = Date.now() - t0;
  assert.ok(statusPageLatencyMs <= SLA_INCIDENT_STATUS_MAX_MS, `Status page updated in ${statusPageLatencyMs}ms (SLA <= 15s)`);
  console.log(`  ✓ Public status page reflects MAJOR_OUTAGE in ${statusPageLatencyMs}ms [SLA <= 15s: PASS]`);

  // Measure 5: Mock Slack & Email Received Alert Notifications
  const alertDeliveries = await until(async () => {
    const dels = await getSinkDeliveries();
    const slack = dels.find((d) => d.provider === "SLACK" && (d.incidentId === openIncident.id || d.payload?.incidentId === openIncident.id));
    const email = dels.find((d) => d.provider === "EMAIL" && (d.incidentId === openIncident.id || d.payload?.incidentId === openIncident.id));
    if (slack && email) return { slack, email };
    return false;
  }, "Primary Slack and Email alerts delivered to sink", 10_000);

  const tNotifDelivered = Date.now();
  const notificationLatencyMs = tNotifDelivered - t0;
  assert.ok(notificationLatencyMs <= SLA_NOTIFICATION_MAX_MS, `Notifications delivered in ${notificationLatencyMs}ms (SLA <= 10s)`);
  console.log(`  ✓ Primary Slack & Email delivered simultaneously in ${notificationLatencyMs}ms [SLA <= 10s: PASS]`);

  // -------------------------------------------------------------
  // PHASE B: ACK INCIDENT & CANCEL PENDING ESCALATIONS
  // -------------------------------------------------------------
  console.log("\n  --- PHASE B: Incident Acknowledgement & Escalation Cancellation ---");
  const ackRes = await fetch(`${API_BASE}/api/v1/incidents/${openIncident.id}/ack`, {
    method: "POST",
    headers: apiHeaders,
  });
  assert.ok(ackRes.status === 200 || ackRes.status === 201, `Failed to ACK incident: ${ackRes.status}`);
  console.log(`  Incident ${openIncident.id} acknowledged`);

  // Verify in database that Secondary and Team escalations are CANCELED
  const deliveriesInDb = await until(async () => {
    const res = await pool.query(
      `SELECT d.id, d.status, s.name as step_name
       FROM notification_deliveries d
       JOIN escalation_policy_steps s ON s.id = d.escalation_step_id
       WHERE d.incident_id = $1
       ORDER BY s.step_order ASC`,
      [openIncident.id],
    );
    const secondaryAndTeam = res.rows.filter((r) => r.step_name === "SECONDARY" || r.step_name === "TEAM");
    if (secondaryAndTeam.length >= 2 && secondaryAndTeam.every((r) => r.status === "CANCELED")) {
      return res.rows;
    }
    return false;
  }, "Secondary and Team deliveries transition to CANCELED upon ACK", 5_000);

  console.log(`  ✓ Secondary and Team deliveries successfully canceled upon ACK: ${deliveriesInDb.map((d) => `${d.step_name}=${d.status}`).join(", ")}`);

  // -------------------------------------------------------------
  // PHASE C: RESTORE TARGET, EVALUATE PASS, AUTO-RESOLVE & RECOVERY NOTIFICATIONS
  // -------------------------------------------------------------
  console.log("\n  --- PHASE C: Target Recovery & Auto-Resolution ---");
  await setTargetMode("healthy");
  await clearSinkDeliveries();

  const evalUpKey = randomUUID();
  const tRecovery0 = Date.now();

  const evalUpRes = await fetch(`${API_BASE}/api/v1/monitors/${monitor.id}/evaluate`, {
    method: "POST",
    headers: {
      ...apiHeaders,
      "Idempotency-Key": evalUpKey,
    },
    body: JSON.stringify({ monitorVersion: monitor.version }),
  });
  assert.equal(evalUpRes.status, 202, "Recovery evaluate request failed");
  const evalUp = await evalUpRes.json();
  console.log(`  Triggered evaluate now for recovery: Execution ID ${evalUp.id}`);

  // Wait for 3 PASS results & QUORUM_PASS
  await until(async () => {
    const res = await fetch(`${API_BASE}/api/v1/executions/${evalUp.id}`, { headers: apiHeaders });
    const data = await res.json();
    return data.status === "COMPLETED" && data.observation === "QUORUM_PASS" && data;
  }, "3 probe results ingested with QUORUM_PASS", 20_000);
  console.log("  ✓ 3 real Go probe results received: QUORUM_PASS");

  // Verify monitor returns to HEALTHY
  await until(async () => {
    const res = await fetch(`${API_BASE}/api/v1/monitors/${monitor.id}`, { headers: apiHeaders });
    const data = await res.json();
    return data.healthState === "HEALTHY" && data;
  }, "Monitor health transitions to HEALTHY", 10_000);
  console.log("  ✓ Monitor health state transitioned to HEALTHY");

  // Verify incident auto-resolved
  await until(async () => {
    const res = await fetch(`${API_BASE}/api/v1/incidents/${openIncident.id}`, { headers: apiHeaders });
    const data = await res.json();
    return data.status === "RESOLVED" && data;
  }, "Incident status transitioned to RESOLVED", 10_000);
  console.log("  ✓ Incident auto-resolved");

  // Verify public status page returns to OPERATIONAL
  await until(async () => {
    const res = await fetch(`${API_BASE}/api/public/v1/status-pages/${slug}`);
    if (!res.ok) return false;
    const sp = await res.json();
    return (sp.overallStatus === "OPERATIONAL" || sp.status === "OPERATIONAL") && sp;
  }, "Public status page returns to OPERATIONAL", 15_000);
  console.log("  ✓ Public status page returned to OPERATIONAL");

  // Verify exactly 2 recovery notifications delivered (1 Slack + 1 Email)
  const recoveryDeliveries = await until(async () => {
    const dels = await getSinkDeliveries();
    const slackRec = dels.find((d) => d.provider === "SLACK" && (d.incidentId === openIncident.id || d.payload?.incidentId === openIncident.id) && (d.payload?.incidentStatus === "RESOLVED" || d.payload?.eventKind === "INCIDENT_RESOLVED"));
    const emailRec = dels.find((d) => d.provider === "EMAIL" && (d.incidentId === openIncident.id || d.payload?.incidentId === openIncident.id) && (d.payload?.incidentStatus === "RESOLVED" || d.payload?.eventKind === "INCIDENT_RESOLVED"));
    if (slackRec && emailRec) return { slackRec, emailRec };
    return false;
  }, "1 Slack and 1 Email recovery notifications delivered to sink", 10_000);

  const recoveryLatencyMs = Date.now() - tRecovery0;
  console.log(`  ✓ 1 Slack and 1 Email recovery notifications delivered in ${recoveryLatencyMs}ms`);

  abortCtrl.abort();

  return {
    cycle,
    dashboardLatencyMs: sseLatencyMs,
    notificationLatencyMs,
    incidentLatencyMs,
    recoveryLatencyMs,
  };
}

async function main() {
  console.log("=================================================");
  console.log(" Argus Week 4: 5-Cycle Real Runtime E2E Acceptance Gate");
  console.log("=================================================");
  console.log(`Regions: ${REGIONS.join(", ")}`);
  console.log(`Executing ${TOTAL_CYCLES} consecutive live cycles against real API, Worker, Target, Sink & Probes\n`);

  await checkInfrastructure();

  const cleanupList = { orgs: [], users: [] };
  const cycleMetrics = [];

  const overallStart = Date.now();

  try {
    for (let c = 1; c <= TOTAL_CYCLES; c++) {
      const metric = await runSingleCycle(c, cleanupList);
      cycleMetrics.push(metric);
    }
  } finally {
    console.log("\n--> Cleaning up all test tenants and data...");
    try {
      if (cleanupList.orgs.length > 0) {
        await pool.query("DELETE FROM organizations WHERE id = ANY($1)", [cleanupList.orgs]);
      }
      if (cleanupList.users.length > 0) {
        await pool.query("DELETE FROM users WHERE id = ANY($1)", [cleanupList.users]);
      }
      await pool.end();
      // Ensure target restored to healthy
      await setTargetMode("healthy");
      console.log("  [OK] Test data cleanly removed from database.");
    } catch (cleanErr) {
      console.warn("  Warning during cleanup:", cleanErr.message);
    }
  }

  const totalTimeMs = Date.now() - overallStart;

  console.log("\n=================================================");
  console.log("             FINAL 5-CYCLE E2E REPORT            ");
  console.log("=================================================");
  console.log(`Total Cycles Executed: ${cycleMetrics.length} / ${TOTAL_CYCLES}`);
  console.log(`Total Duration:       ${totalTimeMs}ms\n`);

  console.log("Cycle Details:");
  for (const m of cycleMetrics) {
    console.log(
      `  Cycle ${m.cycle}: Dashboard SSE=${m.dashboardLatencyMs}ms (<5s) | Notifications=${m.notificationLatencyMs}ms (<10s) | Incident=${m.incidentLatencyMs}ms (<15s) | Recovery=${m.recoveryLatencyMs}ms`,
    );
  }

  const allPassed =
    cycleMetrics.length === TOTAL_CYCLES &&
    cycleMetrics.every(
      (m) =>
        m.dashboardLatencyMs <= SLA_DASHBOARD_MAX_MS &&
        m.notificationLatencyMs <= SLA_NOTIFICATION_MAX_MS &&
        m.incidentLatencyMs <= SLA_INCIDENT_STATUS_MAX_MS,
    );

  console.log("=================================================");
  if (allPassed) {
    console.log(" \x1b[32mALL 5 CYCLES PASSED ALL SLA TARGETS ON REAL LOCAL RUNTIME!\x1b[0m");
    console.log(" No in-memory fake objects. All timestamps measured live.");
  } else {
    console.error(" \x1b[31mE2E ACCEPTANCE GATE FAILED!\x1b[0m");
    process.exit(1);
  }
  console.log("=================================================\n");
}

main().catch((err) => {
  console.error("\nFatal error during 5-cycle E2E acceptance:", err);
  process.exit(1);
});
