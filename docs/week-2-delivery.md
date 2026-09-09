# Week 2 delivery tracker

Source: supplied Argus Execution Pipeline plan. No production deployment or Terraform apply.

- [ ] **In progress:** contracts v0.2, tenant-safe migration and deterministic domain reducer. Check: contracts:check, domain tests. Rollback: isolated test database only.
- [ ] Scheduler, durable outbox, leases/results, finalization, incidents and SSE. Depends on schema/domain; PostgreSQL/Redis concurrency and ownership tests.
- [ ] Long-running Go probe and realtime operator UI. Depends on public contracts; Go race/vet and UI component/E2E tests.
- [ ] Full Compose, metrics, CI and Terraform extension. Depends on pipeline; fresh-stack, chaos, load, rollback/reapply and image scans.
- [ ] Full verification, adversarial review and release report. Record actual commands and remaining limitations.

Required tooling: existing pnpm workspace, Docker (available), Go and Terraform via existing container images. Additional dependency installation awaits user authorization.

Full checks: `pnpm verify`, Go format/vet/race tests, Playwright E2E, `docker compose config`, fresh Compose drill, migration roundtrip, Terraform fmt/validate, vulnerability scans. No Git metadata exists in this workspace.

## Session evidence — 2026-09-05

Source implementation is present for every planned layer, but the overall plan is **not accepted/complete**. The first schema/contracts slice remains in progress until migration verification. Later slices have source changes staged in the workspace, not verified runtime delivery.

| Check | Observed result |
|---|---|
| `pnpm contracts:generate` / `pnpm contracts:check` | Passed; four generated TypeScript/Go files, OpenAPI v0.2 with probe schemas unchanged at v0.1 |
| `pnpm --filter @argus/domain test` | Passed: 40 tests |
| `pnpm --filter @argus/domain typecheck` / `build` | Passed |
| API focused Vitest: result.validation, monitors.controller, monitor.validation, environment | Passed: 20 tests |
| `pnpm --filter @argus/web test` | Passed: 3 component tests |
| `pnpm --filter @argus/web typecheck` / `build` | Passed, including new monitor and incident routes |
| `pnpm --filter @argus/web exec playwright test e2e/execution-pipeline.spec.ts` | Passed: 2 browser tests with mocked API/SSE, not a real full-stack test |
| `docker compose config --quiet` | Passed |
| `node --check` for chaos-drill and migration-roundtrip | Passed; syntax only |
| API typecheck | Blocked: `redis` and the new `@argus/domain` dependency are not installed/linked |
| PostgreSQL/Redis integration, load, migration roundtrip | Not run |
| Go format/vet/race, probe container smoke/soak | Not run; native Go unavailable, existing Go Docker image available |
| Fresh Compose/chaos, full real-API E2E, image scans | Not run |
| Terraform fmt/validate/plan | Not run; native Terraform unavailable, existing Docker image available; no AWS credentials checked |

The user-provided working agreement requires explicit authorization before dependency installation. An approval question for `pnpm install` and local Docker build/testing is pending. Manifests include the new dependencies, but `pnpm-lock.yaml` has intentionally not been regenerated before that authorization; frozen-lockfile CI is not ready yet.

## Next authorized execution after approval

1. Install/link dependencies, regenerate lockfile, compile API, fix compiler/runtime findings.
2. Run Go formatter/vet/race in the existing `golang:1.26.6-bookworm` container; confirm generated models still match.
3. Start an isolated local PostgreSQL/Redis stack, migrate, run `pnpm verify` plus integration/load and migration roundtrip.
4. Build/start fresh Compose, run chaos and real-API UI tests, inspect logs and image scan results.
5. Terraform fmt/validate in the existing container; plan only if credentials are supplied. No apply.
6. Re-review transaction/contract/security behavior, repair confirmed failures, then issue the final release report.

Source review already corrected proxy-origin validation, production-build mock-auth behavior in local Compose, reclaim cursor starvation, React ref initialization and a test assertion that included the Next.js developer toolbar. Runtime review remains mandatory.

## Week-three register

Deferred per plan: notifications/on-call/escalation, status pages, retention automation and actual multi-AWS-region probe deployment. Event/result history is retained in week two. Production service networking, deployment and secret provisioning need a separate authorized rollout; the week-two Terraform change supplies optional resource/task definitions only.
