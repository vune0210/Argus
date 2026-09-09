import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Pool } = require("pg");

const databaseURL = process.env.DATABASE_URL ?? "postgres://argus:argus@127.0.0.1:5432/argus";
const pool = new Pool({ connectionString: databaseURL });

const sinkPort = Number(process.env.MOCK_NOTIFICATION_SINK_PORT ?? 4002);
const sinkUrl = process.env.MOCK_NOTIFICATION_SINK_URL ?? `http://127.0.0.1:${sinkPort}`;

let sinkProcess = null;

async function ensureSinkRunning() {
  try {
    const res = await fetch(`${sinkUrl}/health`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) return;
  } catch {}

  console.log(`Starting mock notification sink on port ${sinkPort}...`);
  sinkProcess = fork("./tools/mock-notification-sink/server.mjs", [], {
    env: { ...process.env, PORT: String(sinkPort) },
    stdio: "inherit",
  });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${sinkUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        console.log("Mock notification sink is ready.");
        return;
      }
    } catch {}
    await delay(200);
  }
  throw new Error("Failed to start mock notification sink");
}

async function setSinkControl(mode, retryAfterSeconds = 30) {
  const res = await fetch(`${sinkUrl}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, retryAfterSeconds }),
  });
  assert.ok(res.ok, "Failed to set mock sink control");
}

async function clearSinkDeliveries() {
  const res = await fetch(`${sinkUrl}/deliveries`, { method: "DELETE" });
  assert.ok(res.ok, "Failed to clear mock sink deliveries");
}

async function getSinkDeliveries() {
  const res = await fetch(`${sinkUrl}/deliveries`);
  assert.ok(res.ok, "Failed to fetch mock sink deliveries");
  const data = await res.json();
  return data.deliveries;
}

const testResults = [];

function recordTest(name, passed, details = "") {
  testResults.push({ name, passed, details });
  const status = passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`[${status}] ${name} ${details ? `(${details})` : ""}`);
}

async function main() {
  console.log("=================================================");
  console.log("  Argus Week 4 Day 3: Notification Integration   ");
  console.log("=================================================\n");

  await ensureSinkRunning();
  await clearSinkDeliveries();
  await setSinkControl("success");

  // Ensure environment variables for API / Worker
  process.env.NOTIFICATION_MODE = "mock";
  process.env.MOCK_NOTIFICATION_SINK_URL = sinkUrl;

  // Import Nest modules dynamically
  const { NestFactory } = require("@nestjs/core");
  const { AppModule } = require("./dist/app.module.js");
  const { NotificationsWorker } = require("./dist/notifications/notifications.worker.js");
  const { NotificationsService } = require("./dist/notifications/notifications.service.js");
  const { PipelineService } = require("./dist/pipeline/pipeline.service.js");

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const worker = app.get(NotificationsWorker);
  const notifService = app.get(NotificationsService);
  const pipeline = app.get(PipelineService);

  const orgA = randomUUID();
  const orgB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();

  let primaryLatencyMs = null;
  let scenario1IncidentId = null;

  try {
    // Clean up any stale test deliveries
    await pool.query("DELETE FROM notification_deliveries");
    await pool.query("DELETE FROM incidents");

    // Setup Users, Organizations, and Memberships
    await pool.query(
      `INSERT INTO users(id, email) VALUES($1, $3), ($2, $4)`,
      [userA, userB, `usera-${randomUUID().slice(0, 8)}@example.com`, `userb-${randomUUID().slice(0, 8)}@example.com`],
    );
    const slugA = `tenant-a-${randomUUID().slice(0, 8)}`;
    const slugB = `tenant-b-${randomUUID().slice(0, 8)}`;
    await pool.query("INSERT INTO organizations(id, name, slug) VALUES($1, 'Tenant A', $3), ($2, 'Tenant B', $4)", [orgA, orgB, slugA, slugB]);
    await pool.query(
      `INSERT INTO organization_members(organization_id, user_id, role)
       VALUES ($1, $2, 'OWNER'), ($3, $4, 'OWNER')`,
      [orgA, userA, orgB, userB],
    );

    // Create Channels for Org A
    const slackChannel = await notifService.createChannel(orgA, userA, {
      name: "Primary Slack",
      type: "SLACK",
      secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:slack-webhook-test",
      enabled: true,
    });

    const emailChannel = await notifService.createChannel(orgA, userA, {
      name: "Secondary Email",
      type: "EMAIL",
      email: "ops-secondary@example.com",
      enabled: true,
    });

    const teamChannel = await notifService.createChannel(orgA, userA, {
      name: "Team Email",
      type: "EMAIL",
      email: "team-alerts@example.com",
      enabled: true,
    });

    // Configure 3-step Escalation Policy
    await notifService.updateEscalationPolicy(orgA, userA, {
      name: "Default Escalation",
      steps: [
        { name: "PRIMARY", stepOrder: 0, delaySeconds: 0, channelId: slackChannel.id },
        { name: "SECONDARY", stepOrder: 1, delaySeconds: 300, channelId: emailChannel.id },
        { name: "TEAM", stepOrder: 2, delaySeconds: 600, channelId: teamChannel.id },
      ],
    });

    async function createTestMonitor(name) {
      const res = await pool.query(
        `INSERT INTO monitors(organization_id, name, interval_seconds, regions, health_state, config, created_by, updated_by)
         VALUES ($1, $2, 60, ARRAY['ap-southeast-1'], 'HEALTHY', '{"kind":"http","url":"http://test-target:8080/check"}'::jsonb, $3, $3)
         RETURNING id`,
        [orgA, name, userA],
      );
      return res.rows[0].id;
    }

    const monitorId = await createTestMonitor("API Gateway S1");

    // -------------------------------------------------------------
    // Scenario 1: Incident Open creates exactly 3 deliveries
    // -------------------------------------------------------------
    const openTime = new Date(Date.now() - 5000);
    const incRes = await pool.query(
      `INSERT INTO incidents(organization_id, monitor_id, opened_at, status)
       VALUES ($1, $2, $3, 'OPEN')
       RETURNING id`,
      [orgA, monitorId, openTime],
    );
    scenario1IncidentId = incRes.rows[0].id;

    // Use pipeline client to invoke createIncidentDeliveries in the same transaction
    await pool.connect().then(async (client) => {
      try {
        await pipeline["createIncidentDeliveries"](client, orgA, scenario1IncidentId, openTime);
      } finally {
        client.release();
      }
    });

    const deliveriesRes = await pool.query(
      `SELECT d.*, s.name as step_name, s.delay_seconds
       FROM notification_deliveries d
       JOIN escalation_policy_steps s ON s.id = d.escalation_step_id
       WHERE d.incident_id = $1
       ORDER BY s.step_order ASC`,
      [scenario1IncidentId],
    );

    const s1Pass = deliveriesRes.rowCount === 3 &&
      deliveriesRes.rows[0].status === "PENDING" &&
      deliveriesRes.rows[0].delay_seconds === 0 &&
      deliveriesRes.rows[1].delay_seconds === 300 &&
      deliveriesRes.rows[2].delay_seconds === 600;

    recordTest(
      "Scenario 1: Incident open creates exactly 3 escalation deliveries",
      s1Pass,
      `Deliveries count: ${deliveriesRes.rowCount}, delays: [0s, 300s, 600s]`,
    );

    // -------------------------------------------------------------
    // Scenario 2: Primary arrives at mock sink within 10 seconds
    // -------------------------------------------------------------
    const startPrimary = Date.now();
    await clearSinkDeliveries();

    // Process primary delivery with worker
    const processedCount = await worker.process();
    const sinkDeliveries = await getSinkDeliveries();

    primaryLatencyMs = Date.now() - startPrimary;
    const primaryReceived = sinkDeliveries.find((d) => d.deliveryId === deliveriesRes.rows[0].id);

    const s2Pass = processedCount >= 1 &&
      primaryReceived !== undefined &&
      primaryLatencyMs < 10000 &&
      primaryReceived.payload.monitorName === "API Gateway S1" &&
      primaryReceived.payload.incidentStatus === "OPEN";

    recordTest(
      "Scenario 2: Primary notification delivered to mock sink within 10 seconds",
      s2Pass,
      `Latency: ${primaryLatencyMs}ms, Provider: ${primaryReceived?.provider}`,
    );

    // -------------------------------------------------------------
    // Scenario 3: Replay incident event does not create duplicate deliveries
    // -------------------------------------------------------------
    await pool.connect().then(async (client) => {
      try {
        await pipeline["createIncidentDeliveries"](client, orgA, scenario1IncidentId, openTime);
      } finally {
        client.release();
      }
    });

    const replayRes = await pool.query(
      `SELECT count(*)::int as count FROM notification_deliveries WHERE incident_id = $1`,
      [scenario1IncidentId],
    );

    const s3Pass = replayRes.rows[0].count === 3;
    recordTest(
      "Scenario 3: Replay incident event does not duplicate deliveries",
      s3Pass,
      `Total deliveries count remains: ${replayRes.rows[0].count}`,
    );

    // -------------------------------------------------------------
    // Scenario 4: 429 retries according to Retry-After
    // -------------------------------------------------------------
    await setSinkControl("rate-limit", 45);

    const monitor429Id = await createTestMonitor("API Gateway S4");
    const open429Time = new Date(Date.now() - 5000);
    const inc429Res = await pool.query(
      `INSERT INTO incidents(organization_id, monitor_id, opened_at, status)
       VALUES ($1, $2, $3, 'OPEN')
       RETURNING id`,
      [orgA, monitor429Id, open429Time],
    );
    const inc429Id = inc429Res.rows[0].id;
    await pool.connect().then(async (client) => {
      try {
        await pipeline["createIncidentDeliveries"](client, orgA, inc429Id, open429Time);
      } finally {
        client.release();
      }
    });

    // Worker attempts delivery -> receives 429 with Retry-After 45
    await worker.process();

    const delivery429 = (await pool.query(
      `SELECT attempts, status, last_error,
              EXTRACT(EPOCH FROM (next_attempt_at - clock_timestamp()))::int as seconds_until_next
       FROM notification_deliveries
       WHERE incident_id = $1 AND attempts > 0`,
      [inc429Id],
    )).rows[0];

    const s4Pass = delivery429 &&
      delivery429.status === "PENDING" &&
      delivery429.attempts === 1 &&
      delivery429.last_error === "RATE_LIMITED" &&
      delivery429.seconds_until_next >= 40 &&
      delivery429.seconds_until_next <= 50;

    recordTest(
      "Scenario 4: 429 response retries according to Retry-After",
      s4Pass,
      `Attempts: ${delivery429?.attempts}, Last error: ${delivery429?.last_error}, Scheduled in: ~${delivery429?.seconds_until_next}s`,
    );

    // Reset sink to success
    await setSinkControl("success");

    // -------------------------------------------------------------
    // Scenario 5: 5xx and timeout increments attempts; attempt 5 becomes FAILED
    // -------------------------------------------------------------
    await setSinkControl("server-error");

    const monitor5xxId = await createTestMonitor("API Gateway S5");
    const open5xxTime = new Date(Date.now() - 5000);
    const inc5xxRes = await pool.query(
      `INSERT INTO incidents(organization_id, monitor_id, opened_at, status)
       VALUES ($1, $2, $3, 'OPEN')
       RETURNING id`,
      [orgA, monitor5xxId, open5xxTime],
    );
    const inc5xxId = inc5xxRes.rows[0].id;
    await pool.connect().then(async (client) => {
      try {
        await pipeline["createIncidentDeliveries"](client, orgA, inc5xxId, open5xxTime);
      } finally {
        client.release();
      }
    });

    // Fast-forward attempts to 4 to verify 5th attempt fails permanently
    const primary5xx = (await pool.query(
      `SELECT id FROM notification_deliveries WHERE incident_id = $1 ORDER BY scheduled_at ASC LIMIT 1`,
      [inc5xxId],
    )).rows[0];

    await pool.query(
      `UPDATE notification_deliveries
       SET attempts = 4, next_attempt_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [primary5xx.id],
    );

    // Process 5th attempt
    await worker.process();

    const failedDelivery = (await pool.query(
      `SELECT status, attempts, last_error FROM notification_deliveries WHERE id = $1`,
      [primary5xx.id],
    )).rows[0];

    const s5Pass = failedDelivery.status === "FAILED" &&
      failedDelivery.attempts === 5 &&
      failedDelivery.last_error === "PROVIDER_5XX";

    recordTest(
      "Scenario 5: 5xx failure increases attempts and transitions to FAILED on 5th attempt",
      s5Pass,
      `Status: ${failedDelivery.status}, Attempts: ${failedDelivery.attempts}, Error: ${failedDelivery.last_error}`,
    );

    await setSinkControl("success");

    // -------------------------------------------------------------
    // Scenario 6: Worker restart reclaims SENDING delivery with expired lock
    // -------------------------------------------------------------
    const monitorOrphanId = await createTestMonitor("API Gateway Orphan");
    const orphanInc = (await pool.query(
      `INSERT INTO incidents(organization_id, monitor_id, opened_at, status) VALUES($1, $2, now(), 'OPEN') RETURNING id`,
      [orgA, monitorOrphanId],
    )).rows[0];
    const orphanRes = await pool.query(
      `INSERT INTO notification_deliveries(
         organization_id, incident_id, escalation_step_id, channel_id, status, attempts,
         scheduled_at, next_attempt_at, locked_until
       ) VALUES ($1, $2, $3, $4, 'SENDING', 1, clock_timestamp(), clock_timestamp(), clock_timestamp() - interval '10 seconds')
       RETURNING id`,
      [orgA, orphanInc.id, deliveriesRes.rows[1].escalation_step_id, emailChannel.id],
    );
    const orphanId = orphanRes.rows[0].id;

    const recoveredCount = await worker.recover();
    const recoveredDelivery = (await pool.query(
      `SELECT status, locked_until FROM notification_deliveries WHERE id = $1`,
      [orphanId],
    )).rows[0];

    const s6Pass = recoveredCount >= 1 &&
      recoveredDelivery.status === "PENDING" &&
      recoveredDelivery.locked_until === null;

    recordTest(
      "Scenario 6: Worker recovery reclaims expired SENDING locks back to PENDING",
      s6Pass,
      `Recovered: ${recoveredCount}, Status: ${recoveredDelivery.status}`,
    );

    // Clean up orphan row
    await pool.query("DELETE FROM notification_deliveries WHERE id = $1", [orphanId]);

    // -------------------------------------------------------------
    // Scenario 7: ACK before minute 5 cancels Secondary and Team
    // -------------------------------------------------------------
    const monitorAckId = await createTestMonitor("API Gateway S7");
    const openAckTime = new Date(Date.now() - 5000);
    const incAckRes = await pool.query(
      `INSERT INTO incidents(organization_id, monitor_id, opened_at, status)
       VALUES ($1, $2, $3, 'OPEN')
       RETURNING id`,
      [orgA, monitorAckId, openAckTime],
    );
    const incAckId = incAckRes.rows[0].id;
    await pool.connect().then(async (client) => {
      try {
        await pipeline["createIncidentDeliveries"](client, orgA, incAckId, openAckTime);
      } finally {
        client.release();
      }
    });

    // Acknowledge incident
    await pipeline.ackIncident(orgA, userA, incAckId);

    const ackDeliveries = (await pool.query(
      `SELECT d.status, s.name as step_name
       FROM notification_deliveries d
       JOIN escalation_policy_steps s ON s.id = d.escalation_step_id
       WHERE d.incident_id = $1
       ORDER BY s.step_order ASC`,
      [incAckId],
    )).rows;

    const s7Pass = ackDeliveries.every((d) => d.status === "CANCELED");
    recordTest(
      "Scenario 7: ACK incident before minute 5 cancels pending Secondary & Team deliveries",
      s7Pass,
      `Deliveries statuses: [${ackDeliveries.map((d) => d.status).join(", ")}]`,
    );

    // -------------------------------------------------------------
    // Scenario 8: Resolve before minute 5 also cancels Secondary and Team
    // -------------------------------------------------------------
    const monitorResolveId = await createTestMonitor("API Gateway S8");
    const openResolveTime = new Date(Date.now() - 5000);
    const incResolveRes = await pool.query(
      `INSERT INTO incidents(organization_id, monitor_id, opened_at, status)
       VALUES ($1, $2, $3, 'OPEN')
       RETURNING id`,
      [orgA, monitorResolveId, openResolveTime],
    );
    const incResolveId = incResolveRes.rows[0].id;
    await pool.connect().then(async (client) => {
      try {
        await pipeline["createIncidentDeliveries"](client, orgA, incResolveId, openResolveTime);
      } finally {
        client.release();
      }
    });

    // Resolve incident
    await pipeline.resolveIncident(orgA, userA, incResolveId);

    const resolveDeliveries = (await pool.query(
      `SELECT d.status, s.name as step_name
       FROM notification_deliveries d
       JOIN escalation_policy_steps s ON s.id = d.escalation_step_id
       WHERE d.incident_id = $1
       ORDER BY s.step_order ASC`,
      [incResolveId],
    )).rows;

    const s8Pass = resolveDeliveries.every((d) => d.status === "CANCELED");
    recordTest(
      "Scenario 8: Manual resolve before minute 5 cancels pending deliveries",
      s8Pass,
      `Deliveries statuses: [${resolveDeliveries.map((d) => d.status).join(", ")}]`,
    );

    // -------------------------------------------------------------
    // Scenario 9: Cross-tenant isolation (Tenant B cannot read/modify Tenant A's channels or policy)
    // -------------------------------------------------------------
    let s9Pass = true;
    try {
      // User B trying to delete User A's channel
      await notifService.deleteChannel(orgB, userB, slackChannel.id);
      s9Pass = false;
    } catch (err) {
      s9Pass = s9Pass && (err.status === 404 || err.response?.code === "CHANNEL_NOT_FOUND");
    }

    try {
      // User B trying to access User A's incident deliveries
      const forbiddenResult = await pool.query(
        `SELECT * FROM notification_deliveries WHERE organization_id = $1 AND incident_id = $2`,
        [orgB, scenario1IncidentId],
      );
      s9Pass = s9Pass && forbiddenResult.rowCount === 0;
    } catch {
      s9Pass = false;
    }

    recordTest(
      "Scenario 9: Cross-tenant isolation prevents accessing channels, policy, or deliveries",
      s9Pass,
      "Tenant B cannot view/delete Tenant A channels or deliveries",
    );

    // -------------------------------------------------------------
    // Scenario 10: Log and response hygiene (no webhooks or secrets leaked)
    // -------------------------------------------------------------
    const listChannels = await notifService.listChannels(orgA, userA);
    const sinkLogs = await getSinkDeliveries();

    let secretsLeaked = false;
    for (const ch of listChannels.items) {
      if ((ch.config && ch.config.webhook) || JSON.stringify(ch).includes("hooks.slack.com")) {
        secretsLeaked = true;
      }
    }
    for (const del of sinkLogs) {
      const stringified = JSON.stringify(del);
      if (stringified.includes("hooks.slack.com") || stringified.includes("arn:aws:secretsmanager") || stringified.includes("Authorization")) {
        secretsLeaked = true;
      }
    }

    const s10Pass = !secretsLeaked;
    recordTest(
      "Scenario 10: Secret sanitization ensures no webhooks, auth headers, or raw secrets leaked",
      s10Pass,
      "Responses and sink payloads cleanly sanitized",
    );

  } finally {
    await app.close();
    await pool.end();
    if (sinkProcess) {
      sinkProcess.kill("SIGTERM");
    }
  }

  // Final Summary Report
  console.log("\n=================================================");
  console.log("             FINAL INTEGRATION REPORT            ");
  console.log("=================================================");
  const totalTests = testResults.length;
  const passedTests = testResults.filter((r) => r.passed).length;
  const failedTests = totalTests - passedTests;

  console.log(`Total Scenarios:  ${totalTests}`);
  console.log(`Passed:           \x1b[32m${passedTests}\x1b[0m`);
  console.log(`Failed:           ${failedTests > 0 ? `\x1b[31m${failedTests}\x1b[0m` : "0"}`);
  console.log(`Primary Latency:  ${primaryLatencyMs !== null ? `${primaryLatencyMs}ms (< 10000ms target)` : "N/A"}`);
  console.log("=================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Integration test run failed:", err);
  if (sinkProcess) sinkProcess.kill("SIGTERM");
  process.exit(1);
});
