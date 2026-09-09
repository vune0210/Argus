import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Pool } = require("pg");

const databaseURL = process.env.DATABASE_URL ?? "postgres://argus:argus@127.0.0.1:5432/argus";
const pool = new Pool({ connectionString: databaseURL });

const testResults = [];

function recordTest(name, passed, details = "") {
  testResults.push({ name, passed, details });
  const status = passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`[${status}] ${name} ${details ? `(${details})` : ""}`);
}

async function main() {
  console.log("=================================================");
  console.log("  Argus Week 4 Day 4: Status Page Integration    ");
  console.log("=================================================\n");

  // Spin up Nest app on an ephemeral port
  const { NestFactory } = require("@nestjs/core");
  const { AppModule } = require("./dist/app.module.js");
  const { ErrorEnvelopeFilter } = require("./dist/common/error.filter.js");

  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await app.listen(0);
  const port = app.getHttpServer().address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test Nest server listening on ${baseUrl}`);

  const orgA = randomUUID();
  const orgB = randomUUID();
  const userOwner = randomUUID();
  const userAdmin = randomUUID();
  const userResponder = randomUUID();
  const userViewer = randomUUID();
  const userOrgB = randomUUID();

  let monitorA1, monitorA2, monitorA3, monitorA4, monitorB1, monitorDeleted;
  let statusPageId = null;

  try {
    // 1. Seed Database with Tenants and Users
    await pool.query(
      `INSERT INTO users(id, email) VALUES
       ($1, $6), ($2, $7), ($3, $8), ($4, $9), ($5, $10)`,
      [
        userOwner, userAdmin, userResponder, userViewer, userOrgB,
        `owner-${randomUUID().slice(0, 8)}@example.com`,
        `admin-${randomUUID().slice(0, 8)}@example.com`,
        `resp-${randomUUID().slice(0, 8)}@example.com`,
        `viewer-${randomUUID().slice(0, 8)}@example.com`,
        `orgb-${randomUUID().slice(0, 8)}@example.com`,
      ],
    );

    const slugOrgA = `tenant-a-${randomUUID().slice(0, 8)}`;
    const slugOrgB = `tenant-b-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO organizations(id, name, slug) VALUES ($1, 'Tenant A', $3), ($2, 'Tenant B', $4)`,
      [orgA, orgB, slugOrgA, slugOrgB],
    );

    await pool.query(
      `INSERT INTO organization_members(organization_id, user_id, role) VALUES
       ($1, $2, 'OWNER'),
       ($1, $3, 'ADMIN'),
       ($1, $4, 'RESPONDER'),
       ($1, $5, 'VIEWER'),
       ($6, $7, 'OWNER')`,
      [orgA, userOwner, userAdmin, userResponder, userViewer, orgB, userOrgB],
    );

    // Create Monitors
    async function createMonitor(orgId, userId, name, healthState) {
      const res = await pool.query(
        `INSERT INTO monitors(organization_id, name, interval_seconds, regions, health_state, config, created_by, updated_by)
         VALUES ($1, $2, 60, ARRAY['ap-southeast-1'], $3, '{"kind":"http","url":"http://test-target:8080/check"}'::jsonb, $4, $4)
         RETURNING id`,
        [orgId, name, healthState, userId],
      );
      return res.rows[0].id;
    }

    monitorA1 = await createMonitor(orgA, userOwner, "Payment Service", "HEALTHY");
    monitorA2 = await createMonitor(orgA, userOwner, "Search Service", "DEGRADED");
    monitorA3 = await createMonitor(orgA, userOwner, "Auth Service", "DOWN");
    monitorA4 = await createMonitor(orgA, userOwner, "Analytics Service", "UNKNOWN");
    monitorB1 = await createMonitor(orgB, userOrgB, "Tenant B Monitor", "HEALTHY");

    // Soft-deleted monitor in Org A
    const delRes = await pool.query(
      `INSERT INTO monitors(organization_id, name, interval_seconds, regions, health_state, config, created_by, updated_by, deleted_at)
       VALUES ($1, 'Deleted Monitor', 60, ARRAY['ap-southeast-1'], 'HEALTHY', '{"kind":"http","url":"http://test-target:8080/check"}'::jsonb, $2, $2, NOW())
       RETURNING id`,
      [orgA, userOwner],
    );
    monitorDeleted = delRes.rows[0].id;

    // Helper for authenticated requests
    async function authedApi(path, userId, orgId, method = "GET", body = undefined) {
      return fetch(`${baseUrl}/api/v1/${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-argus-user-id": userId,
          "x-argus-organization-id": orgId,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    }

    // Helper for public requests
    async function publicApi(slug) {
      return fetch(`${baseUrl}/api/public/v1/status-pages/${slug}`);
    }

    // -------------------------------------------------------------
    // Scenario 1: RBAC - Mutations restricted to Owner/Admin
    // -------------------------------------------------------------
    const viewerPostRes = await authedApi("status-pages", userViewer, orgA, "POST", {
      name: "Viewer Page",
      slug: `viewer-page-${randomUUID().slice(0, 6)}`,
      published: true,
      components: [{ monitorId: monitorA1, publicName: "API" }],
    });
    const respPostRes = await authedApi("status-pages", userResponder, orgA, "POST", {
      name: "Responder Page",
      slug: `responder-page-${randomUUID().slice(0, 6)}`,
      published: true,
      components: [{ monitorId: monitorA1, publicName: "API" }],
    });
    const viewerGetRes = await authedApi("status-pages", userViewer, orgA, "GET");

    const s1Pass = viewerPostRes.status === 403 && respPostRes.status === 403 && viewerGetRes.status === 200;
    recordTest(
      "Scenario 1: RBAC restricts mutations to Owner/Admin, allows Viewer read",
      s1Pass,
      `Viewer POST=${viewerPostRes.status}, Responder POST=${respPostRes.status}, Viewer GET=${viewerGetRes.status}`,
    );

    // -------------------------------------------------------------
    // Scenario 2: Create Status Page with multiple components & positions
    // -------------------------------------------------------------
    const initialSlug = `status-page-${randomUUID().slice(0, 8)}`;
    const createRes = await authedApi("status-pages", userOwner, orgA, "POST", {
      name: "Main Public Status",
      slug: initialSlug,
      published: true,
      components: [
        { monitorId: monitorA1, publicName: "Core Payment API" },
        { monitorId: monitorA2, publicName: "Product Search" },
      ],
    });
    assert.equal(createRes.status, 201, "Failed to create status page");
    const createdData = await createRes.json();
    statusPageId = createdData.id;

    const s2Pass = createdData.id &&
      createdData.name === "Main Public Status" &&
      createdData.slug === initialSlug &&
      createdData.version === 1 &&
      createdData.published === true &&
      createdData.components.length === 2 &&
      createdData.components[0].position === 0 &&
      createdData.components[1].position === 1;

    recordTest(
      "Scenario 2: Owner creates status page with ordered components",
      s2Pass,
      `ID=${statusPageId}, Version=${createdData.version}, Components=${createdData.components.length}`,
    );

    // -------------------------------------------------------------
    // Scenario 3: Slug uniqueness (case-insensitive) & concurrency
    // -------------------------------------------------------------
    // Duplicate case-insensitive slug
    const dupRes = await authedApi("status-pages", userAdmin, orgA, "POST", {
      name: "Duplicate Page",
      slug: initialSlug.toUpperCase(),
      published: false,
      components: [{ monitorId: monitorA1, publicName: "API" }],
    });
    const dupBody = await dupRes.json();
    const dupPass = dupRes.status === 409 && dupBody.code === "STATUS_PAGE_SLUG_CONFLICT";

    // Concurrency collision test
    const concurrentSlug = `concurrent-slug-${randomUUID().slice(0, 6)}`;
    const [cRes1, cRes2] = await Promise.all([
      authedApi("status-pages", userOwner, orgA, "POST", {
        name: "Concurrent Page 1",
        slug: concurrentSlug,
        published: true,
        components: [{ monitorId: monitorA1, publicName: "API 1" }],
      }),
      authedApi("status-pages", userOwner, orgA, "POST", {
        name: "Concurrent Page 2",
        slug: concurrentSlug,
        published: true,
        components: [{ monitorId: monitorA1, publicName: "API 2" }],
      }),
    ]);
    const statuses = [cRes1.status, cRes2.status].sort();
    const concurrentPass = statuses[0] === 201 && statuses[1] === 409;

    const s3Pass = dupPass && concurrentPass;
    recordTest(
      "Scenario 3: Slug uniqueness is case-insensitive and handles concurrency",
      s3Pass,
      `Duplicate status=${dupRes.status} (code=${dupBody.code}), Concurrency statuses=[${statuses.join(", ")}]`,
    );

    // -------------------------------------------------------------
    // Scenario 4: Cross-tenant monitor attachment & soft-deleted monitor rejected
    // -------------------------------------------------------------
    const crossTenantRes = await authedApi("status-pages", userOwner, orgA, "POST", {
      name: "Cross Tenant Test",
      slug: `cross-tenant-${randomUUID().slice(0, 6)}`,
      published: false,
      components: [{ monitorId: monitorB1, publicName: "Tenant B API" }],
    });

    const deletedMonRes = await authedApi("status-pages", userOwner, orgA, "POST", {
      name: "Deleted Monitor Test",
      slug: `deleted-mon-${randomUUID().slice(0, 6)}`,
      published: false,
      components: [{ monitorId: monitorDeleted, publicName: "Deleted API" }],
    });

    const s4Pass = crossTenantRes.status === 404 && deletedMonRes.status === 404;
    recordTest(
      "Scenario 4: Cross-tenant and soft-deleted monitors return 404",
      s4Pass,
      `Cross-tenant status=${crossTenantRes.status}, Deleted monitor status=${deletedMonRes.status}`,
    );

    // -------------------------------------------------------------
    // Scenario 5: Optimistic locking version conflict
    // -------------------------------------------------------------
    // Update with stale version (version 0 vs current version 1)
    const stalePatchRes = await authedApi(`status-pages/${statusPageId}`, userAdmin, orgA, "PATCH", {
      version: 0,
      name: "Stale Update",
      components: [{ monitorId: monitorA1, publicName: "Core API" }],
    });
    const staleBody = await stalePatchRes.json();
    const stalePass = stalePatchRes.status === 409 && staleBody.code === "VERSION_CONFLICT";

    // Valid update with current version 1
    const validPatchRes = await authedApi(`status-pages/${statusPageId}`, userAdmin, orgA, "PATCH", {
      version: 1,
      name: "Updated Status Title",
      components: [
        { monitorId: monitorA2, publicName: "Search Component" },
        { monitorId: monitorA1, publicName: "Payment Component" },
      ],
    });
    assert.equal(validPatchRes.status, 200, "Valid PATCH should succeed");
    const patchedData = await validPatchRes.json();
    const patchPass = patchedData.version === 2 &&
      patchedData.name === "Updated Status Title" &&
      patchedData.components[0].publicName === "Search Component" &&
      patchedData.components[0].position === 0 &&
      patchedData.components[1].publicName === "Payment Component" &&
      patchedData.components[1].position === 1;

    const s5Pass = stalePass && patchPass;
    recordTest(
      "Scenario 5: Optimistic locking rejects stale version and increments version on success",
      s5Pass,
      `Stale PATCH=${stalePatchRes.status} (code=${staleBody.code}), Valid PATCH version=${patchedData.version}`,
    );

    // -------------------------------------------------------------
    // Scenario 6: Reordering components updates positions atomically
    // -------------------------------------------------------------
    const reorderRes = await authedApi(`status-pages/${statusPageId}`, userOwner, orgA, "PATCH", {
      version: 2,
      components: [
        { monitorId: monitorA1, publicName: "Payment Component" },
        { monitorId: monitorA2, publicName: "Search Component" },
      ],
    });
    assert.equal(reorderRes.status, 200);
    const reorderData = await reorderRes.json();
    const s6Pass = reorderData.components[0].publicName === "Payment Component" &&
      reorderData.components[0].position === 0 &&
      reorderData.components[1].publicName === "Search Component" &&
      reorderData.components[1].position === 1;
    recordTest(
      "Scenario 6: Reordering components assigns zero-based sequential positions",
      s6Pass,
      `Pos 0=${reorderData.components[0].publicName}, Pos 1=${reorderData.components[1].publicName}`,
    );

    // -------------------------------------------------------------
    // Scenario 7: Public endpoint 404 for draft, deleted, and non-existent
    // -------------------------------------------------------------
    // Create draft (unpublished) page
    const draftSlug = `draft-page-${randomUUID().slice(0, 6)}`;
    await authedApi("status-pages", userOwner, orgA, "POST", {
      name: "Draft Status Page",
      slug: draftSlug,
      published: false,
      components: [{ monitorId: monitorA1, publicName: "API" }],
    });

    const draftPublicRes = await publicApi(draftSlug);
    const nonExistentRes = await publicApi("slug-that-does-not-exist");

    const s7Pass = draftPublicRes.status === 404 && nonExistentRes.status === 404;
    recordTest(
      "Scenario 7: Public endpoint returns 404 for draft or non-existent status pages",
      s7Pass,
      `Draft status=${draftPublicRes.status}, Non-existent status=${nonExistentRes.status}`,
    );

    // -------------------------------------------------------------
    // Scenario 8: Public endpoint caching header and unauthenticated access
    // -------------------------------------------------------------
    const pubRes = await publicApi(initialSlug);
    assert.equal(pubRes.status, 200, "Published status page must return 200");
    const cacheControlHeader = pubRes.headers.get("cache-control");
    const expectedHeader = "public, max-age=15, stale-while-revalidate=30";

    const s8Pass = pubRes.status === 200 && cacheControlHeader === expectedHeader;
    recordTest(
      "Scenario 8: Public endpoint serves unauthenticated requests with correct Cache-Control",
      s8Pass,
      `Cache-Control='${cacheControlHeader}'`,
    );

    // -------------------------------------------------------------
    // Scenario 9: Privacy Deny-List verification
    // -------------------------------------------------------------
    // Ensure an incident exists for monitorA1
    const testIncRes = await pool.query(
      `INSERT INTO incidents(organization_id, monitor_id, opened_at, acknowledged_at, acknowledged_by, status)
       VALUES ($1, $2, NOW() - interval '2 hours', NOW() - interval '1 hour', $3, 'ACKNOWLEDGED')
       RETURNING id`,
      [orgA, monitorA1, userAdmin],
    );
    const testIncidentId = testIncRes.rows[0].id;

    // Fetch public status page again to check serialized output
    const checkPubRes = await publicApi(initialSlug);
    const serializedBody = await checkPubRes.text();
    const parsedPub = JSON.parse(serializedBody);

    const denyListPatterns = [
      orgA,
      userOwner,
      userAdmin,
      userResponder,
      userViewer,
      monitorA1,
      monitorA2,
      statusPageId,
      testIncidentId,
      "http://test-target:8080/check",
      "secretArn",
      "latency",
      "executionId",
      "probeId",
      "targetId",
      "@example.com",
    ];

    const leakedPatterns = [];
    for (const pattern of denyListPatterns) {
      if (serializedBody.includes(pattern)) {
        leakedPatterns.push(pattern);
      }
    }

    // Also check incident structure
    const incidentClean = parsedPub.incidents.length > 0 &&
      parsedPub.incidents.every((inc) => {
        return inc.componentName &&
          inc.status &&
          inc.openedAt &&
          !inc.id &&
          !inc.acknowledgedBy &&
          !inc.organizationId &&
          !inc.monitorId;
      });

    const s9Pass = leakedPatterns.length === 0 && incidentClean;
    recordTest(
      "Scenario 9: Privacy deny-list verifies zero internal IDs, configs, latencies, or emails leaked",
      s9Pass,
      leakedPatterns.length > 0 ? `LEAKED: ${leakedPatterns.join(", ")}` : "All deny-list assertions passed",
    );

    // -------------------------------------------------------------
    // Scenario 10: Health mapping and Overall status severity hierarchy
    // -------------------------------------------------------------
    // Create status page with HEALTHY, DEGRADED, DOWN, UNKNOWN
    const multiHealthSlug = `health-test-${randomUUID().slice(0, 6)}`;
    await authedApi("status-pages", userOwner, orgA, "POST", {
      name: "Health Matrix Page",
      slug: multiHealthSlug,
      published: true,
      components: [
        { monitorId: monitorA1, publicName: "Comp Healthy" },
        { monitorId: monitorA2, publicName: "Comp Degraded" },
        { monitorId: monitorA3, publicName: "Comp Down" },
        { monitorId: monitorA4, publicName: "Comp Unknown" },
      ],
    });

    const multiRes = await publicApi(multiHealthSlug);
    const multiData = await multiRes.json();

    const compStatusMap = new Map(multiData.components.map((c) => [c.name, c.status]));
    const healthMapPass =
      compStatusMap.get("Comp Healthy") === "OPERATIONAL" &&
      compStatusMap.get("Comp Degraded") === "DEGRADED" &&
      compStatusMap.get("Comp Down") === "MAJOR_OUTAGE" &&
      compStatusMap.get("Comp Unknown") === "UNKNOWN";

    // Overall status must be MAJOR_OUTAGE (worst of all)
    const overallPass = multiData.overallStatus === "MAJOR_OUTAGE";

    const s10Pass = healthMapPass && overallPass;
    recordTest(
      "Scenario 10: Component health mapping and overall severity hierarchy (MAJOR_OUTAGE > DEGRADED > UNKNOWN > OPERATIONAL)",
      s10Pass,
      `Overall=${multiData.overallStatus}, Statuses=${JSON.stringify(Object.fromEntries(compStatusMap))}`,
    );

    // -------------------------------------------------------------
    // Scenario 11: Uptime and Coverage calculation across 24h, 7d, 30d
    // -------------------------------------------------------------
    // Seed executions for monitorA1
    // 8 QUORUM_PASS (available), 1 SINGLE_REGION_FAILURE (available), 1 QUORUM_FAILURE (unavailable), 2 INSUFFICIENT_RESULTS
    // Total = 12. Valid = 10. Available = 9.
    // Expected uptime = 9 / 10 = 90.00%
    // Expected coverage = 10 / 12 = 83.33%
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3600 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 2 * 86400 * 1000);

    let offsetSec = 0;
    async function insertExecution(monitorId, obs, completedAt) {
      const execId = randomUUID();
      offsetSec += 60;
      const actualCompleted = new Date(completedAt.getTime() + offsetSec * 1000);
      const schedAt = new Date(actualCompleted.getTime() - 10000);
      const deadlineAt = new Date(actualCompleted.getTime() + 10000);
      await pool.query(
        `INSERT INTO executions(id, organization_id, monitor_id, monitor_version, kind, scheduled_at, deadline_at, status, observation, completed_at, config)
         VALUES ($1, $2, $3, 1, 'SCHEDULED', $4, $5, 'COMPLETED', $6, $7, '{}'::jsonb)`,
        [execId, orgA, monitorId, schedAt, deadlineAt, obs, actualCompleted],
      );
    }

    for (let i = 0; i < 8; i++) await insertExecution(monitorA1, "QUORUM_PASS", oneHourAgo);
    await insertExecution(monitorA1, "SINGLE_REGION_FAILURE", oneHourAgo);
    await insertExecution(monitorA1, "QUORUM_FAILURE", oneHourAgo);
    for (let i = 0; i < 2; i++) await insertExecution(monitorA1, "INSUFFICIENT_RESULTS", oneHourAgo);

    // Also add some 2-day-old executions (within 7d and 30d, but outside 24h)
    await insertExecution(monitorA1, "QUORUM_PASS", twoDaysAgo);

    const uptimeRes = await publicApi(initialSlug);
    const uptimeData = await uptimeRes.json();
    const compA1 = uptimeData.components.find((c) => c.name === "Payment Component");

    assert.ok(compA1, "Payment Component must exist in response");
    const uptime24h = compA1.uptime.last24Hours;
    const coverage24h = compA1.coverage.last24Hours;

    // Component monitorA2 has 0 executions -> uptime null, coverage 0.0
    const compA2 = uptimeData.components.find((c) => c.name === "Search Component");
    assert.ok(compA2, "Search Component must exist");
    const noDataUptime = compA2.uptime.last24Hours === null && compA2.coverage.last24Hours === 0;

    const s11Pass = Math.abs(uptime24h - 90.0) < 0.01 &&
      Math.abs(coverage24h - 83.33) < 0.01 &&
      noDataUptime;

    recordTest(
      "Scenario 11: Uptime and coverage math correctly excludes INSUFFICIENT_RESULTS from denominator and handles null",
      s11Pass,
      `Uptime24h=${uptime24h}% (expected 90.00%), Coverage24h=${coverage24h}% (expected 83.33%), NoDataUptime=${compA2.uptime.last24Hours}`,
    );

    // -------------------------------------------------------------
    // Scenario 12: Soft delete does not affect monitors, executions, or incidents
    // -------------------------------------------------------------
    const deleteSpRes = await authedApi(`status-pages/${statusPageId}`, userOwner, orgA, "DELETE");
    assert.equal(deleteSpRes.status, 204, "DELETE must return 204");

    // Verify status page is soft-deleted
    const spDb = await pool.query(`SELECT deleted_at FROM status_pages WHERE id = $1`, [statusPageId]);
    const isSoftDeleted = spDb.rows[0].deleted_at !== null;

    // Verify monitors, executions, and incidents still exist
    const monCount = await pool.query(`SELECT count(*)::int as c FROM monitors WHERE id = $1`, [monitorA1]);
    const incCount = await pool.query(`SELECT count(*)::int as c FROM incidents WHERE id = $1`, [testIncidentId]);
    const execCount = await pool.query(`SELECT count(*)::int as c FROM executions WHERE monitor_id = $1`, [monitorA1]);

    const publicAfterDel = await publicApi(initialSlug);

    const s12Pass = isSoftDeleted &&
      monCount.rows[0].c === 1 &&
      incCount.rows[0].c === 1 &&
      execCount.rows[0].c > 0 &&
      publicAfterDel.status === 404;

    recordTest(
      "Scenario 12: Soft-deleting status page preserves monitors, incidents, executions, and makes public page 404",
      s12Pass,
      `SoftDeleted=${isSoftDeleted}, MonitorCount=${monCount.rows[0].c}, IncidentCount=${incCount.rows[0].c}, PublicStatus=${publicAfterDel.status}`,
    );

  } finally {
    await app.close();
    await pool.end();
  }

  // Final Summary Report
  console.log("\n=================================================");
  console.log("             STATUS PAGE REPORT                  ");
  console.log("=================================================");
  const totalTests = testResults.length;
  const passedTests = testResults.filter((r) => r.passed).length;
  const failedTests = totalTests - passedTests;

  console.log(`Total Scenarios:  ${totalTests}`);
  console.log(`Passed:           \x1b[32m${passedTests}\x1b[0m`);
  console.log(`Failed:           ${failedTests > 0 ? `\x1b[31m${failedTests}\x1b[0m` : "0"}`);
  console.log("=================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Status page integration test failed:", err);
  process.exit(1);
});
