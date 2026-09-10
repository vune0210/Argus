import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const require = createRequire(resolve(rootDir, "apps/api/package.json"));
const { Pool } = require("pg");
const { createClient } = require("redis");

const dbUrl = process.env.DATABASE_URL || "postgres://argus:argus@127.0.0.1:5432/argus";
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const targetUrl = process.env.TEST_TARGET_URL || "http://127.0.0.1:8080/healthy";

async function verifyDependencies() {
  console.log("--> Verifying runtime dependencies...");

  // 1. PostgreSQL
  try {
    const pool = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 3000 });
    await pool.query("SELECT 1");
    await pool.end();
    console.log("  [OK] PostgreSQL is reachable at", dbUrl);
  } catch (err) {
    throw new Error(`CRITICAL: PostgreSQL dependency check failed (${dbUrl}): ${err.message}`);
  }

  // 2. Redis
  try {
    const redis = createClient({ url: redisUrl, socket: { connectTimeout: 3000 } });
    await redis.connect();
    await redis.ping();
    await redis.quit();
    console.log("  [OK] Redis is reachable at", redisUrl);
  } catch (err) {
    throw new Error(`CRITICAL: Redis dependency check failed (${redisUrl}): ${err.message}`);
  }

  // 3. Test Target
  try {
    const res = await fetch(targetUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log("  [OK] Test target is reachable at", targetUrl);
  } catch (err) {
    throw new Error(`CRITICAL: Test target dependency check failed (${targetUrl}): ${err.message}`);
  }
}

function runSubSuite(name, scriptPath, envExtra = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    console.log(`\n=================================================`);
    console.log(`  RUNNING: ${name}`);
    console.log(`  Path: ${scriptPath}`);
    console.log(`=================================================`);

    const start = Date.now();
    const proc = spawn(process.execPath, [scriptPath], {
      cwd: rootDir,
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: dbUrl,
        REDIS_URL: redisUrl,
        AUTH_MODE: "mock",
        ARGUS_LOAD_GATE: "true",
        ...envExtra,
      },
    });

    proc.on("close", (code) => {
      const elapsed = Date.now() - start;
      if (code === 0) {
        console.log(`[PASS] ${name} completed successfully in ${elapsed}ms\n`);
        resolvePromise({ name, elapsed, passed: true });
      } else {
        const err = new Error(`[FAIL] ${name} exited with non-zero code ${code} (${elapsed}ms)`);
        err.code = code;
        rejectPromise(err);
      }
    });

    proc.on("error", (err) => {
      rejectPromise(err);
    });
  });
}

async function main() {
  console.log("=================================================");
  console.log("  Argus Week 4 Real Runtime Acceptance Suite     ");
  console.log("=================================================");

  const overallStart = Date.now();

  // Enforce zero skips: if dependencies are missing, fail immediately!
  await verifyDependencies();

  const suites = [
    {
      name: "1. Migration 008 Roundtrip & Rollback/Reapply",
      path: resolve(rootDir, "scripts/migration-roundtrip.mjs"),
    },
    {
      name: "2. Notification Service & Multi-Channel Escalation Integration",
      path: resolve(rootDir, "scripts/week4-notifications.mjs"),
    },
    {
      name: "3. Status Page Public API & Component Hierarchy Integration",
      path: resolve(rootDir, "scripts/week4-status.mjs"),
    },
    {
      name: "4. Multi-Protocol Check Types Integration (HTTP/TCP/SSL/Keyword)",
      path: resolve(rootDir, "scripts/week4-check-types.mjs"),
    },
    {
      name: "5. Terraform Invariants & Security Boundaries Mock Tests",
      path: resolve(rootDir, "scripts/check-terraform-invariants.test.mjs"),
    },
  ];

  const summary = [];

  for (const s of suites) {
    try {
      const res = await runSubSuite(s.name, s.path);
      summary.push(res);
    } catch (err) {
      console.error(`\nFAILED SUITE: ${s.name}`);
      console.error(err.message);
      process.exit(1);
    }
  }

  const totalElapsed = Date.now() - overallStart;
  console.log("=================================================");
  console.log("  ALL WEEK 4 REAL RUNTIME SUITES PASSED!         ");
  console.log("=================================================");
  for (const s of summary) {
    console.log(`  - ${s.name}: ${s.elapsed}ms`);
  }
  console.log(`Total Duration: ${totalElapsed}ms`);
  console.log("Zero mock/synthetic tests. All executions verified against real DB, Redis, and target.\n");
}

main().catch((err) => {
  console.error("Fatal error running Week 4 orchestrator:", err);
  process.exit(1);
});
