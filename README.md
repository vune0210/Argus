# Argus

Repository: [github.com/vune0210/Argus](https://github.com/vune0210/Argus)

Week-three day-two raw partitioning, probe recovery, UI resilience and regional AWS deployment preparation are documented in [docs/week-3-day-2.md](docs/week-3-day-2.md). Apply migration 004 before starting the updated API/worker; the rollout and rollback order are included there. Day-three local integration evidence and the blocked AWS staging handoff are in [docs/week-3-day-3.md](docs/week-3-day-3.md). Day-four go/no-go, rollout and demo rehearsal are in [docs/week-3-day-4.md](docs/week-3-day-4.md). Day-five-to-seven acceptance evidence, staging blockers and the four-hour soak command are in [docs/week-3-days-5-7.md](docs/week-3-days-5-7.md).

Argus is a distributed uptime monitoring project with a NestJS control plane, Next.js operator console, Go probes, a PostgreSQL execution/outbox pipeline, Redis Streams, incidents and SSE updates. Week-two runtime acceptance is tracked in `docs/week-2-delivery.md`.

## Prerequisites

- Node.js 24+
- pnpm 10.19+
- Go 1.26.6+
- Docker with Compose
- Terraform 1.10+ for infrastructure validation

## Local setup

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev:infra
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000`, choose **Continue as local developer**, and create an HTTP monitor. Mock authentication is accepted only while both `NODE_ENV` and `AUTH_MODE` indicate development or test.

Start `pnpm dev:worker` in a second terminal for local host development. For the complete container stack, use `docker compose up -d --build --wait`; it starts migrations, API, web, worker, Redis, PostgreSQL, the test target and three regional probes. Use `http://test-target:8080/healthy` as the demo monitor URL. Compose uses a development web image so local mock authentication remains available; the final production image requires Cognito.

Open a monitor to inspect execution and region results or use **Run now** for a diagnostic execution. Owner/Admin/Responder can run diagnostics; Viewer can read results and incidents. Diagnostics do not change health. Two scheduled quorum failures open an incident unless flapping suppression applies; two clean passes resolve it.

Run the standalone probe against the local test target:

```powershell
$env:ARGUS_ENV='development'
$env:ARGUS_ALLOW_PRIVATE_TARGETS='true'
Set-Location agents/probe
go run ./cmd/argus-probe execute-file ../../packages/contracts/examples/probe-job.local.json
```

The command writes one `ProbeResult` JSON document to stdout. On bash, set the same two variables with `export`. Local/private targets are allowed only when `ARGUS_ENV=development|test` and `ARGUS_ALLOW_PRIVATE_TARGETS=true`.

When a probe JSON Schema changes, regenerate the shared TypeScript and Go models with `pnpm contracts:generate`. CI runs `pnpm contracts:check` and rejects stale generated files.

Without a local Go installation, use the containerized probe (the image build runs Go unit tests first):

```bash
docker compose --profile tools run --rm probe
```

## Verification

```bash
pnpm verify
cd agents/probe && go test -race ./...
docker compose config
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
```

See `docs/` for the domain glossary, architecture decisions, threat model, and week-two transition matrix.

Week-two acceptance commands (test services must be isolated):

Week-three day-one contracts, regional dashboard, fixtures, readiness blockers and runnable handoff are documented in [docs/week-3-day-1.md](docs/week-3-day-1.md). The live monitor page now includes a tenant-scoped regional snapshot with result freshness and probe heartbeat. `pnpm test:target` exercises the switchable local target; `pnpm test:week3-smoke` requires the isolated running stack and `ARGUS_SMOKE_LOCAL=true`.

```powershell
$env:NODE_ENV='test'
$env:AUTH_MODE='mock'
$env:DATABASE_URL='postgres://argus:argus@127.0.0.1:5432/argus'
$env:REDIS_URL='redis://127.0.0.1:6379'
$env:ARGUS_LOAD_GATE='true'
pnpm --filter @argus/api db:migrate
pnpm verify
pnpm test:migrations
```

After starting the full Compose stack, run `$env:ARGUS_CHAOS_LOCAL='true'; pnpm test:chaos`. The drill stops/restarts only the local Redis, Frankfurt probe and test-target services, checks missing-region/outage/recovery/manual/SSE behavior, then removes its own fixtures. It advances only its own monitor schedules to shorten the test, preserving the normal 60-second interval setting.

For managed registration, provide `ARGUS_PROBE_ID`, `ARGUS_REGION`, `ARGUS_TOKEN`, a private `PROBE_TOKEN_HMAC_KEY`, and the normal API environment through your secret manager, then run `pnpm --filter @argus/api probe:register`. Do not use local Compose tokens outside development/test.
