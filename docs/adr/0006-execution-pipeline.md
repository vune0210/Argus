# ADR 0006: Week-two execution pipeline

Status: implemented in source; runtime acceptance pending dependency authorization.

## Contracts and storage

OpenAPI v0.2 is additive at `/api/v1`. ProbeJob/ProbeResult stay v0.1. TypeScript API models and Go lease/receipt models are generated from the v0.2 source; CI rejects drift. An execution snapshots monitor version/configuration and creates one tenant-keyed target per region. Monitor deletion is soft; historical execution and incident queries remain available.

## Transactions and delivery

Scheduler workers lock due monitors with `FOR UPDATE SKIP LOCKED`, write executions/targets/outbox in one transaction, and advance the next run from current time. Missed intervals are skipped. HTTP processes never start scheduler loops. Scheduler, dispatcher, finalizer and repair loops run independently, so a Redis outage cannot stop PostgreSQL scheduling/finalization.

Redis regional stream: `argus:v1:probe-jobs:{region}`; group: `argus-probes-v1`; dead-letter stream: `argus:v1:probe-jobs:{region}:dlq`. Entries carry target IDs; job data always comes from the authoritative snapshot in PostgreSQL. `XAUTOCLAIM` reclaims pending entries after 45 seconds. PostgreSQL fences the lease ID, probe, region and expiry before granting or accepting results. A maximum of three actual grants is allowed. Duplicate transport entries do not consume an attempt while a valid lease is active.

The result transaction locks execution then target, validates identity, inserts a unique target result and marks the target completed. Only after commit does the API ACK Redis. A matching duplicate returns the original receipt, even after finalization; a conflicting body returns 409. Expired or superseded owners receive 410. Unfinished durable targets can republish their outbox entry after 45 seconds, recovering even a lost Redis stream. Redis reclaim behavior follows the [official XAUTOCLAIM contract](https://redis.io/docs/latest/commands/xautoclaim/).

The finalizer locks monitor then execution. It runs after all targets are terminal or the 150-second execution deadline expires. Missing/poison targets contribute no explicit failure. The domain reducer is pure and takes an injected timestamp. Only scheduled executions from the current monitor version and with a newer sequence may update health. State, counters, transitions, incident actions, domain events and domain outbox writes commit together. A partial unique index enforces one open incident per monitor.

## Incidents and flapping

Two consecutive quorum failures reach DOWN; two consecutive clean passes recover. Every state change counts for flapping: the fourth change within ten minutes suppresses new incidents for fifteen minutes. Existing incidents still resolve. Once suppression expires, an evaluated DOWN state may open the incident that was suppressed. Independent chaos fixtures avoid mistaking intentional flapping suppression for failed incident creation.

## Authentication and replay

Managed probes use HTTPS Bearer tokens, with HMAC digests in PostgreSQL. Local Compose permits HTTP only in development/test. Known development IDs/seeds are refused outside those environments. `ARGUS_TOKEN_FILE` supports client rotation; the registration CLI rotates only the digest for an unchanged probe ID/region/environment. Tokens and response bodies are never logged by the control-plane client.

Domain envelopes are persisted before publication to `argus:v1:domain-events`. The SSE implementation reads the durable event table with bounded one-second polling, providing delivery during Redis outages as well as replay. A per-tenant advisory lock ensures event sequence allocation follows commit order. No event retention deletion runs in week two. Replay cursors older than 24 hours or unknown to the tenant cause `system.resync_required`; initial connections also resync to close the REST-snapshot/subscribe race. Sessions reconnect after five minutes and membership is rechecked during streaming. The web BFF streams bodies and propagates cancellation and Last-Event-ID.

## Operational boundaries

Compose simulates Singapore, Tokyo and Frankfurt. Production minimum interval remains 60 seconds. Worker `/metrics` exposes scheduling lag, durable queue/outbox depth and incident counters; API `/metrics` exposes lease/ingestion latency histograms and duplicate counts. Infrastructure metrics should be reachable only on internal service networking.

Terraform adds optional encrypted ElastiCache and ECS worker/probe task definitions with existing secret ARN references and scheduler disabled. It does not create running ECS services or register real probes. API/worker are the only processes configured with Redis connection information. Probe tasks must use separate egress-only networking when services are deployed. Terraform apply is outside this plan.
