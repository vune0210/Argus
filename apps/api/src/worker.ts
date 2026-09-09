import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseModule } from "./database/database.module";
import { PipelineCoreModule } from "./pipeline/pipeline.module";
import { PipelineService } from "./pipeline/pipeline.service";
import { probeKey } from "./pipeline/probe-auth";
import { DATABASE_POOL } from "./database/database.module";
import type { Pool } from "pg";
import { maintainRawPartitions } from "./pipeline/raw-history";
import { NotificationsModule } from "./notifications/notifications.module";
import { NotificationsWorker } from "./notifications/notifications.worker";

@Module({ imports: [DatabaseModule, PipelineCoreModule, NotificationsModule] })
class WorkerModule {}

async function main(): Promise<void> {
  probeKey();
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const pipeline = app.get(PipelineService);
  const notificationsWorker = app.get(NotificationsWorker);
  const pool = app.get<Pool>(DATABASE_POOL);
  try { await maintainRawPartitions(pool); }
  catch (error) { await app.close(); throw error; }
  let stopped = false;
  const shutdown = new AbortController();
  const metrics: Record<string, number> = {};
  const server = createServer((req, res) => {
    if (req.url !== "/metrics") { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", "text/plain; version=0.0.4");
    res.end(Object.entries(metrics).map(([key, value]) => `argus_worker_${key} ${value}`).join("\n") + "\n");
  }).listen(Number(process.env.WORKER_METRICS_PORT ?? 4001), "0.0.0.0");
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { stopped = true; shutdown.abort(); });
  async function loop(name: string, action: () => Promise<unknown>, interval: number): Promise<void> {
    while (!stopped) {
      const start = Date.now();
      const operationId = randomUUID();
      let processedCount = 0;
      let safeErrorCode: string | undefined;
      try {
        const result = await action();
        processedCount = typeof result === "number" ? result : Array.isArray(result) ? result.length : 1;
        metrics[`${name}_total`] = (metrics[`${name}_total`] ?? 0) + processedCount;
      } catch (error) {
        metrics[`${name}_errors_total`] = (metrics[`${name}_errors_total`] ?? 0) + 1;
        safeErrorCode = error instanceof Error ? error.name : "UNKNOWN_ERROR";
      }
      const durationSeconds = (Date.now() - start) / 1000;
      metrics[`${name}_duration_seconds`] = durationSeconds;

      if (processedCount > 0 || safeErrorCode || name === "gauges" || name === "partitions") {
        console.log(JSON.stringify({
          level: safeErrorCode ? "error" : "info",
          timestamp: new Date().toISOString(),
          service: "argus-worker",
          operationId,
          loop: name,
          durationSeconds,
          processedCount,
          ...(safeErrorCode ? { errorCode: safeErrorCode } : {}),
        }));
      }
      await delay(interval, undefined, { signal: shutdown.signal }).catch(() => undefined);
    }
  }
  await Promise.all([
    loop("scheduler", () => process.env.SCHEDULER_ENABLED === "true" ? pipeline.schedule() : Promise.resolve(0), 100),
    loop("outbox", () => pipeline.dispatch(), 100),
    loop("finalizer", () => pipeline.finalize(), 500),
    loop("repair", () => pipeline.repair(), 5000),
    loop("gauges", async () => {
      const g = await pipeline.gauges();
      Object.assign(metrics, g);

      // CloudWatch Embedded Metric Format (EMF) output for native AWS observability
      const environment = process.env.NODE_ENV || "staging";
      const emf = {
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "Argus/Worker",
              Dimensions: [["Environment"]],
              Metrics: [
                { Name: "SchedulerLagSeconds", Unit: "Seconds" },
                { Name: "QueueDepth", Unit: "Count" },
                { Name: "OutboxDepth", Unit: "Count" },
                { Name: "NotificationFailures", Unit: "Count" },
                { Name: "NotificationRetries", Unit: "Count" },
                { Name: "StaleProbesCount", Unit: "Count" },
                { Name: "IncidentsOpened", Unit: "Count" },
                { Name: "IncidentsResolved", Unit: "Count" },
              ],
            },
          ],
        },
        Environment: environment,
        SchedulerLagSeconds: Number(g.scheduler_lag_seconds ?? 0),
        QueueDepth: Number(g.queue_depth ?? 0),
        OutboxDepth: Number(g.outbox_depth ?? 0),
        NotificationFailures: Number(g.notification_failures_total ?? 0),
        NotificationRetries: Number(g.notification_retries_total ?? 0),
        StaleProbesCount: Number(g.stale_probes_count ?? 0),
        IncidentsOpened: Number(g.incidents_opened_total ?? 0),
        IncidentsResolved: Number(g.incidents_resolved_total ?? 0),
        service: "argus-worker",
      };
      console.log(JSON.stringify(emf));
    }, 5000),
    loop("notifications", () => notificationsWorker.process(), 500),
    loop("notifications_recovery", () => notificationsWorker.recover(), 5000),
  ]);
  server.close();
  await app.close();
}
main().catch(() => { console.error("Worker startup failed; check environment and dependencies"); process.exitCode = 1; });
