# Week-one threat model

| Threat | Boundary | Week-one control | Follow-up |
|---|---|---|---|
| SSRF and DNS rebinding | Probe outbound network | Resolve every connection, reject non-global addresses, re-check redirects, cap redirects/body/time | Add organization egress policy |
| Cross-tenant access | API/database | Resolve membership from the database and include `organization_id` in every monitor query | Automated policy tests on every resource |
| Token leakage | Web/API/probe logs | HTTP-only web cookies, structured redaction, never serialize probe token | KMS-backed agent credential rotation |
| Duplicate delivery | Future queue/result ingestion | Contract includes immutable execution/probe IDs | Unique result constraint and idempotent consumers |
| Probe impersonation | Future probe API | Token is config-only and redacted | Short-lived probe session and rotation |
| Development auth in production | API/Web | Startup fails if mock auth is selected outside development/test | CI policy and deployment guard |

Security failures are release blockers. Private targets are permitted only in explicit local test mode and are disabled in deployed environments.
# Week-two additions

| Threat | Control |
|---|---|
| Probe token disclosure | HMAC digest at rest; HTTPS for managed clients; no token/body logging; token file rotation |
| Probe impersonation or cross-region delivery | Bearer guard derives probe/region from storage; ownership and snapshot identity checked inside result transaction |
| Duplicate or conflicting results | Unique target result, stable receipt, 409 for a different duplicate body |
| Expired worker overwrites newer result | Lease ID fencing, current owner and expiry checks, 410 for stale grants |
| Missing infrastructure raises false incident | Missing targets never count as failures; strict quorum and two-stage DOWN transition |
| Tenant event or history leakage | Composite tenant foreign keys and membership checks on every read/SSE session |
| Replay misses late commits | Per-tenant event allocation lock; durable PostgreSQL replay; resync for invalid/old cursors |
| BFF forwards identity to attacker URL | API-origin and `/api/v1/` path allowlist; redirect forwarding disabled |
| Redis restart loses jobs | Durable target/outbox repair plus idempotent ingestion after transport redelivery |
