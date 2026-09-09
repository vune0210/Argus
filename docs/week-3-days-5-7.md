# Tuần 3 / ngày 5–7 — Demo, hardening và chốt milestone

## Kết quả thực hiện

Public contracts không thay đổi. Local release candidate đã qua smoke, recovery, browser E2E, load gate, migration roundtrip và Terraform mock tests trên PostgreSQL/Redis cô lập.

Staging AWS vẫn **BLOCKED** vì môi trường hiện tại không có AWS account/role, remote-state backend, HTTPS control-plane URL, ba secret ARN, GitHub repository/OIDC environment hoặc artifact `verified-regional-release`. Không có ECS task ARN, ECR digest, CloudWatch evidence, staging migration hoặc staging screenshot để nghiệm thu.

## Evidence local

| Kiểm tra | Kết quả |
| --- | --- |
| Three-region smoke | PASS; execution `0bbdd6bc-75c0-406c-bc79-3603e3602165`, ba result/raw copy, SSE và tenant isolation. |
| Probe recovery | PASS; kill probe, reclaim tự nhiên, old owner HTTP 410, một raw result. |
| Browser runtime | PASS: 3 Playwright tests với API, worker và Go probes thật; có desktop/mobile screenshots trong test artifacts. |
| Soak harness validation | PASS 60 giây; 2 execution, mỗi execution có ba target/result/raw copy, đúng SSE event, heartbeat ALIVE, max attempts 1 và pending outbox 0. |
| Workspace verification | PASS: contracts, lint, typecheck, build; 51 domain, 38 API, 20 web, 2 target và 1 release test. |
| Load gate | PASS: 1.000 execution, 3.000 target, scheduler p95 2,226 giây. |
| Migration roundtrip | PASS: migrate, rollback và reapply trên database tạm. |
| Terraform | PASS: fmt check, validate và 2 mock tests; còn warning `aws_region.current.name` deprecated. |

Phiên 60 giây chỉ kiểm chứng hoạt động của soak harness. Soak bốn giờ chưa chạy và không được ghi là đạt. Harness `pnpm test:week3-soak` mặc định chạy bốn giờ, chỉ cho phép API/database local, dọn fixture sau khi kết thúc và fail nếu thiếu result, duplicate event, heartbeat stale hoặc outbox không drain.

## Staging gate và owners

| Dependency | Owner | Điều kiện đóng |
| --- | --- | --- |
| AWS role và remote-state backend | QA/SRE | Bootstrap plan được review/apply qua workflow được phê duyệt. |
| HTTPS control-plane staging | Backend | Health và probe endpoints hoạt động qua HTTPS/443. |
| Ba Secrets Manager ARN và probe HMAC registration | Backend + QA/SRE | Ba identity ACTIVE, không lộ token. |
| GitHub repository, OIDC role và protected staging environment | QA/SRE | Workflow release lấy được credential bằng OIDC. |
| Verified regional artifact | Probe + QA/SRE | Cùng revision và manifest digest ở ba ECR repository. |
| ECS/dashboard runtime evidence | QA/SRE + Frontend | Task ARN, heartbeat, execution ID, logs và screenshot staging được lưu. |

Khi gate mở, thực hiện thứ tự trong `docs/week-3-day-4.md`: bootstrap với desired count 0, migration/backfill, probe registration, publish artifact, rollout Singapore → Tokyo → Frankfurt, rồi mới chạy staging acceptance.

## Quyết định cuối tuần và tuần 4

Milestone “ba AWS region gửi kết quả về staging dashboard” đang **BLOCKED**. Milestone local đã đạt, nhưng không thay thế staging acceptance.

Backlog tuần 4 được giữ đúng phạm vi: quorum failure → incident automation → status page. Trước khi bắt đầu, Tech Lead khóa incident invariants; Backend chốt transaction/dedup; Frontend chốt incident/status presentation; Probe giữ nguyên result contract; QA/SRE cung cấp staging dependencies và E2E environment.

Terraform deprecation warning thuộc QA/SRE và phải được xử lý trước lần nâng AWS provider tiếp theo. Database dùng chung cũ có backlog do fixture load-test thất bại trước đó; mọi acceptance tiếp theo phải dùng database/Redis cô lập hoặc staging thật.

## Chạy soak bốn giờ

Sau khi khởi động API, worker, test target và ba probe local trên database/Redis cô lập:

```powershell
$env:ARGUS_SOAK_LOCAL='true'
$env:ARGUS_SOAK_TARGET='http://host.docker.internal:8080/check'
pnpm test:week3-soak
```

Không đặt `ARGUS_SOAK_DURATION_MS` để giữ mặc định bốn giờ. Kết quả đạt phải có `status: PASS`, không có heartbeat stale, mỗi execution có đúng ba result/raw copy, SSE event count đúng và `pendingOutbox: 0`.
