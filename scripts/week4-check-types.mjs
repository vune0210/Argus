import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

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
  console.log("  Argus Week 4 Day 4: Check Types Integration    ");
  console.log("=================================================\n");

  // Ensure environment variables for probe auth
  process.env.SEED_DEV_PROBES = "true";
  process.env.PROBE_TOKEN_HMAC_KEY = "local-development-hmac-key-not-for-production";

  // Spin up Nest app on ephemeral port
  const { NestFactory } = require("@nestjs/core");
  const { AppModule } = require("./dist/app.module.js");
  const { ErrorEnvelopeFilter } = require("./dist/common/error.filter.js");
  const { DATABASE_POOL } = require("./dist/database/database.module.js");
  const { seedDevelopmentProbes, digestToken, probeKey } = require("./dist/pipeline/probe-auth.js");
  const { PipelineService } = require("./dist/pipeline/pipeline.service.js");

  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await seedDevelopmentProbes(app.get(DATABASE_POOL));
  await app.listen(0);
  const port = app.getHttpServer().address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test Nest server listening on ${baseUrl}`);

  const pipelineService = app.get(PipelineService);
  const { RedisStreams } = require("./dist/pipeline/redis-streams.js");
  const redisStreams = app.get(RedisStreams);

  const orgId = randomUUID();
  const userId = randomUUID();
  const region = "check-types-reg";
  const probeId = "dev-check-types";
  const probeToken = "argp_dev-check-types.secret-token-for-testing-12345678";

  // Register dedicated test probe
  const tokenDigest = digestToken(probeToken, probeKey());
  await pool.query(
    `INSERT INTO probe_agents(id, region, token_digest, is_development)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (id) DO UPDATE SET region = EXCLUDED.region, token_digest = EXCLUDED.token_digest`,
    [probeId, region, tokenDigest],
  );

  try {
    // Clean up any stale unpublished outbox events and clear test stream
    await pool.query("DELETE FROM outbox_events WHERE published_at IS NULL");
    await redisStreams.command(["DEL", `argus:v1:probe-jobs:${region}`]);

    async function dispatchAll() {
      while ((await pipelineService.dispatch(100)) > 0);
    }

    // 1. Setup Tenant & User
    await pool.query(
      `INSERT INTO users(id, email) VALUES ($1, $2)`,
      [userId, `checktype-test-${randomUUID().slice(0, 8)}@example.com`],
    );
    const orgSlug = `tenant-checktypes-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO organizations(id, name, slug) VALUES ($1, 'CheckTypes Tenant', $2)`,
      [orgId, orgSlug],
    );
    await pool.query(
      `INSERT INTO organization_members(organization_id, user_id, role) VALUES ($1, $2, 'OWNER')`,
      [orgId, userId],
    );

    // Helpers
    async function authedApi(path, method = "GET", body = undefined) {
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

    async function probeApi(path, method = "POST", body = undefined) {
      return fetch(`${baseUrl}/api/v1/probe-leases${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${probeToken}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    }

    // -------------------------------------------------------------
    // Scenario 1: Monitor creation validation for all 4 check types
    // -------------------------------------------------------------
    const httpRes = await authedApi("monitors", "POST", {
      name: "HTTP Check",
      intervalSeconds: 60,
      regions: [region],
      config: {
        kind: "http",
        url: "http://test-target:8080/check",
        method: "GET",
        timeoutMs: 5000,
        expectedStatus: 200,
        maxRedirects: 5,
        maxResponseBytes: 1048576,
      },
    });

    const tcpRes = await authedApi("monitors", "POST", {
      name: "TCP Check",
      intervalSeconds: 60,
      regions: [region],
      config: {
        kind: "tcp",
        host: "test-target",
        port: 8080,
        timeoutMs: 3000,
      },
    });

    const sslRes = await authedApi("monitors", "POST", {
      name: "SSL Check",
      intervalSeconds: 60,
      regions: [region],
      config: {
        kind: "ssl",
        host: "test-target",
        port: 8443,
        timeoutMs: 3000,
        warnBeforeDays: 30,
      },
    });

    const keywordRes = await authedApi("monitors", "POST", {
      name: "Keyword Check",
      intervalSeconds: 60,
      regions: [region],
      config: {
        kind: "keyword",
        url: "http://test-target:8080/keyword/match",
        method: "GET",
        expectedStatus: 200,
        keyword: "ARGUS_KEYWORD_MATCH",
        matchMode: "contains",
        caseSensitive: false,
        maxRedirects: 5,
        maxResponseBytes: 1048576,
        timeoutMs: 5000,
      },
    });

    const s1Pass = httpRes.status === 201 &&
      tcpRes.status === 201 &&
      sslRes.status === 201 &&
      keywordRes.status === 201;

    const httpData = await httpRes.json();
    const tcpData = await tcpRes.json();
    const sslData = await sslRes.json();
    const keywordData = await keywordRes.json();

    recordTest(
      "Scenario 1: Monitor creation succeeds for all 4 check types (http, tcp, ssl, keyword)",
      s1Pass,
      `HTTP=${httpRes.status}, TCP=${tcpRes.status}, SSL=${sslRes.status}, Keyword=${keywordRes.status}`,
    );

    // Prevent background worker scheduler from auto-scheduling test monitors
    await pool.query("UPDATE monitors SET next_run_at = now() + interval '1 day' WHERE organization_id = $1", [orgId]);
    await pool.query("DELETE FROM execution_targets WHERE region = $1", [region]);
    await pool.query("DELETE FROM outbox_events WHERE stream = $1", [`argus:v1:probe-jobs:${region}`]);
    await redisStreams.command(["DEL", `argus:v1:probe-jobs:${region}`]);

    // -------------------------------------------------------------
    // Scenario 2: Validation rejection of invalid configurations
    // -------------------------------------------------------------
    const invalidTcpPort = await authedApi("monitors", "POST", {
      name: "Bad TCP Port",
      intervalSeconds: 60,
      regions: [region],
      config: { kind: "tcp", host: "test-target", port: 70000, timeoutMs: 3000 },
    });

    const missingTcpHost = await authedApi("monitors", "POST", {
      name: "Missing Host TCP",
      intervalSeconds: 60,
      regions: [region],
      config: { kind: "tcp", port: 8080, timeoutMs: 3000 },
    });

    const invalidKeywordMode = await authedApi("monitors", "POST", {
      name: "Bad MatchMode",
      intervalSeconds: 60,
      regions: [region],
      config: {
        kind: "keyword",
        url: "http://test-target:8080/keyword/match",
        method: "GET",
        expectedStatus: 200,
        keyword: "TEST",
        matchMode: "INVALID_MODE",
        maxRedirects: 5,
        maxResponseBytes: 1048576,
        timeoutMs: 5000,
      },
    });

    const emptyKeywordStr = await authedApi("monitors", "POST", {
      name: "Empty Keyword",
      intervalSeconds: 60,
      regions: [region],
      config: {
        kind: "keyword",
        url: "http://test-target:8080/keyword/match",
        method: "GET",
        expectedStatus: 200,
        keyword: "",
        matchMode: "contains",
        maxRedirects: 5,
        maxResponseBytes: 1048576,
        timeoutMs: 5000,
      },
    });

    const invalidSslDays = await authedApi("monitors", "POST", {
      name: "Bad SSL Days",
      intervalSeconds: 60,
      regions: [region],
      config: {
        kind: "ssl",
        host: "test-target",
        port: 443,
        timeoutMs: 3000,
        warnBeforeDays: -5,
      },
    });

    const s2Pass = invalidTcpPort.status === 400 &&
      missingTcpHost.status === 400 &&
      invalidKeywordMode.status === 400 &&
      emptyKeywordStr.status === 400 &&
      invalidSslDays.status === 400;

    recordTest(
      "Scenario 2: Validation correctly rejects invalid configurations with 400 Bad Request",
      s2Pass,
      `BadPort=${invalidTcpPort.status}, MissingHost=${missingTcpHost.status}, BadMode=${invalidKeywordMode.status}, EmptyKw=${emptyKeywordStr.status}, BadSsl=${invalidSslDays.status}`,
    );

    // -------------------------------------------------------------
    // Scenario 3: Scheduler and probe leasing emits schema 0.1 for HTTP and 0.2 for new check types
    // -------------------------------------------------------------
    // Clear queue before testing leasing
    await redisStreams.command(["DEL", `argus:v1:probe-jobs:${region}`]);

    // Run execution for HTTP monitor
    await authedApi(`monitors/${httpData.id}/run`, "POST");
    await dispatchAll();
    const httpLease = await pipelineService.lease({ id: probeId, region });
    assert.ok(httpLease, "HTTP job should be leased");
    const httpSchemaPass = httpLease.job.schemaVersion === "0.1" && httpLease.job.config.kind === "http";

    // Run execution for TCP monitor
    await authedApi(`monitors/${tcpData.id}/run`, "POST");
    await dispatchAll();
    const tcpLease = await pipelineService.lease({ id: probeId, region });
    assert.ok(tcpLease, "TCP job should be leased");
    const tcpSchemaPass = tcpLease.job.schemaVersion === "0.2" &&
      tcpLease.job.config.kind === "tcp" &&
      tcpLease.job.config.host === "test-target" &&
      tcpLease.job.config.port === 8080;

    // Run execution for Keyword monitor
    await authedApi(`monitors/${keywordData.id}/run`, "POST");
    await dispatchAll();
    const kwLease = await pipelineService.lease({ id: probeId, region });
    assert.ok(kwLease, "Keyword job should be leased");
    const kwSchemaPass = kwLease.job.schemaVersion === "0.2" &&
      kwLease.job.config.kind === "keyword" &&
      kwLease.job.config.keyword === "ARGUS_KEYWORD_MATCH";

    const s3Pass = httpSchemaPass && tcpSchemaPass && kwSchemaPass;
    recordTest(
      "Scenario 3: Probe leasing emits schema 0.1 for HTTP (backwards compatible) and 0.2 for TCP/Keyword",
      s3Pass,
      `HTTP Schema=${httpLease.job.schemaVersion}, TCP Schema=${tcpLease.job.schemaVersion}, Keyword Schema=${kwLease.job.schemaVersion}`,
    );

    // -------------------------------------------------------------
    // Scenario 4: Ingestion rejects result kind mismatch
    // -------------------------------------------------------------
    // Try to submit HTTP result for TCP leased job
    const tcpSched = Date.parse(tcpLease.job.scheduledAt);
    const mismatchRes = await probeApi(`/${tcpLease.leaseId}/result`, "POST", {
      schemaVersion: "0.1",
      executionId: tcpLease.job.executionId,
      organizationId: tcpLease.job.organizationId,
      monitorId: tcpLease.job.monitorId,
      monitorVersion: tcpLease.job.monitorVersion,
      probeId: probeId,
      region,
      startedAt: new Date(tcpSched + 10).toISOString(),
      completedAt: new Date(tcpSched + 50).toISOString(),
      durationMs: 40,
      outcome: "PASS",
      http: {
        statusCode: 200,
        responseBytes: 100,
      },
    });

    const mismatchData = await mismatchRes.json();
    const s4Pass = mismatchRes.status === 409 &&
      (mismatchData.message?.includes("Result kind mismatch") || mismatchData.error?.includes("mismatch"));

    recordTest(
      "Scenario 4: Ingestion rejects result kind mismatch (submitting HTTP result for TCP job) with 409",
      s4Pass,
      `Status=${mismatchRes.status}, Message='${mismatchData.message}'`,
    );

    // -------------------------------------------------------------
    // Scenario 5: Valid result ingestion and duplicate handling
    // -------------------------------------------------------------
    // Submit valid TCP result for the TCP leased job
    const schedTime = Date.parse(tcpLease.job.scheduledAt);
    const validTcpResult = {
      schemaVersion: "0.2",
      executionId: tcpLease.job.executionId,
      organizationId: tcpLease.job.organizationId,
      monitorId: tcpLease.job.monitorId,
      monitorVersion: tcpLease.job.monitorVersion,
      probeId: probeId,
      region,
      startedAt: new Date(schedTime + 10).toISOString(),
      completedAt: new Date(schedTime + 52).toISOString(),
      durationMs: 42,
      outcome: "PASS",
      tcp: {
        connected: true,
      },
    };

    const validRes = await probeApi(`/${tcpLease.leaseId}/result`, "POST", validTcpResult);
    assert.equal(validRes.status, 200, "Valid TCP result ingestion should succeed");
    const validReceipt = await validRes.json();

    // Duplicate submission
    const dupRes = await probeApi(`/${tcpLease.leaseId}/result`, "POST", validTcpResult);
    assert.equal(dupRes.status, 200, "Duplicate result should return 200");
    const dupReceipt = await dupRes.json();

    // Verify DB records
    const checkRes = await pool.query(
      `SELECT count(*)::int as c FROM check_results c
       JOIN probe_results p ON p.id = c.result_id
       WHERE p.organization_id = $1`,
      [tcpLease.job.organizationId],
    );

    const s5Pass = validReceipt.duplicate === false &&
      dupReceipt.duplicate === true &&
      checkRes.rows[0].c === 1;

    recordTest(
      "Scenario 5: Valid check result ingestion succeeds and duplicate idempotency is preserved",
      s5Pass,
      `Initial dup=${validReceipt.duplicate}, Resubmission dup=${dupReceipt.duplicate}, Stored count=${checkRes.rows[0].c}`,
    );

    // -------------------------------------------------------------
    // Scenario 6: Test-target Keyword integration (/keyword/match and /keyword/mismatch)
    // -------------------------------------------------------------
    const matchRes = await fetch("http://127.0.0.1:8080/keyword/match");
    const matchText = await matchRes.text();

    const mismatchTargetRes = await fetch("http://127.0.0.1:8080/keyword/mismatch");
    const mismatchText = await mismatchTargetRes.text();

    // Check CONTAINS logic
    const containsMatch = matchText.includes("ARGUS_KEYWORD_MATCH_TARGET_OK");
    const containsMismatch = mismatchText.includes("ARGUS_KEYWORD_MATCH_TARGET_OK");

    // Check NOT_CONTAINS logic
    const notContainsMatch = !matchText.includes("NO_MATCH_TARGET");
    const notContainsMismatchFail = mismatchText.includes("NO_MATCH_TARGET");

    const s6Pass = matchRes.status === 200 &&
      mismatchTargetRes.status === 200 &&
      containsMatch &&
      !containsMismatch &&
      notContainsMatch &&
      notContainsMismatchFail;

    recordTest(
      "Scenario 6: Test target responds to /keyword/match and /keyword/mismatch with appropriate fixture content",
      s6Pass,
      `MatchStatus=${matchRes.status}, ContainsExpected=${containsMatch}, MismatchHasKeyword=${containsMismatch}`,
    );

    // -------------------------------------------------------------
    // Scenario 7: Go probe contracts and executor tests pass in Docker
    // -------------------------------------------------------------
    let goTestsPassed = false;
    let goOutput = "";
    try {
      const workspacePath = process.cwd().replace(/\\/g, "/");
      goOutput = execSync(
        `docker run --rm -v "${workspacePath}:/workspace" -w /workspace/agents/probe golang:1.26.6-alpine go test ./internal/contracts ./internal/executor`,
        { encoding: "utf-8" },
      );
      goTestsPassed = goOutput.includes("PASS") || goOutput.includes("ok  \tgithub.com/vune0210/Argus/agents/probe/internal/executor");
    } catch (e) {
      goOutput = e.stdout || e.message;
    }

    recordTest(
      "Scenario 7: Go probe internal contracts and executors test suite passes in Go test runner",
      goTestsPassed,
      goTestsPassed ? "All Go contract and executor tests passed" : `Failed: ${goOutput}`,
    );

  } finally {
    try {
      await pool.query("DELETE FROM check_results c USING probe_results p, execution_targets t WHERE c.result_id = p.id AND p.target_id = t.id AND t.probe_id = $1", [probeId]);
      await pool.query("DELETE FROM probe_results p USING execution_targets t WHERE p.target_id = t.id AND t.probe_id = $1", [probeId]);
      await pool.query("DELETE FROM execution_targets WHERE probe_id = $1", [probeId]);
      await pool.query("DELETE FROM probe_agents WHERE id = $1", [probeId]);
    } catch (e) {
      console.warn("Cleanup warning:", e.message);
    }
    await app.close();
    await pool.end();
  }

  // Final Summary Report
  console.log("\n=================================================");
  console.log("             CHECK TYPES REPORT                  ");
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
  console.error("Check types integration test failed:", err);
  process.exit(1);
});
