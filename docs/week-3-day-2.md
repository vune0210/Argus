# Tuần 3 / ngày 2 — Dữ liệu, recovery và hạ tầng ba region

## Kết quả triển khai

- Có migration `004_check_results.sql`, raw history partition theo UTC, backfill theo batch có thể chạy lại, và rollback bảo toàn canonical receipt/result.
- Ingestion ghi canonical result + raw copy + target completed + event/outbox trong cùng transaction; ACK chỉ sau commit. Job/result/snapshot/SSE public contracts không thay đổi.
- Có kiểm thử reclaim bằng probe khác, lỗi ghi raw, mất ACK/response và replay qua nửa đêm. Script runtime còn kill container Go thật và chờ reclaim tự nhiên.
- Dashboard giữ dữ liệu kèm cảnh báo khi mạng lỗi, refetch khi phục hồi, refresh heartbeat không cần SSE mới, và xóa dữ liệu khi API/stream trả lỗi mất quyền. Execution console cũng xóa monitor/history liên quan khi bị từ chối.
- Có Terraform root riêng cho Singapore/Tokyo/Frankfurt và workflow phân phối một image artifact tới ba ECR repository. Chưa publish hoặc apply AWS.

## Storage contract và thứ tự rollout

`probe_results` vẫn là canonical source dùng cho receipt, duplicate comparison, evaluator và snapshot. `execution_targets` giữ unique execution/region và `probe_results` giữ unique target. Không chuyển query hiện có sang bảng raw trong ngày 2.

`check_results` partition RANGE theo `received_at`, PK `(received_at,result_id)` và FK `(result_id,organization_id,received_at)` trỏ canonical record. FK cố định cả tenant và timestamp, nên không thể tạo bản sao cùng canonical result ở một ngày khác. Ingestion dùng `INSERT ... SELECT` để giữ chính xác microsecond PostgreSQL; không round-trip timestamp qua JavaScript Date khi ghi raw.

Mỗi partition có range UTC `[00:00, ngày kế tiếp 00:00)`. Migration tạo hôm nay và ngày mai. Worker gọi maintenance trước scheduler và lặp năm phút/lần; DDL không nằm trong hot path ingestion. Backfill lấy tối đa 1.000 record thiếu/batch, tạo partition cho ngày của batch và insert idempotent. Maintenance/backfill dùng cùng advisory lock khi tạo partition; không có retention/drop-partition tự động.

Thứ tự triển khai:

1. Chạy migration 004 trước khi khởi động API/worker ngày 2.
2. Khởi động worker maintenance và API mới; kiểm tra `argus_worker_partitions_errors_total` không tăng.
3. Sau khi các API phiên bản cũ đã được thay thế, chạy `db:backfill-raw` đến khi không còn thiếu; chạy lại phải báo `inserted: 0`.
4. Nếu partition thiếu hoặc ghi raw lỗi, toàn transaction ingestion rollback, không ACK. Khôi phục maintenance/storage rồi probe retry trong lease/deadline; không thêm fallback làm bỏ mất raw write.

Rollback: dừng/rollback API và worker về source trước 004 trước khi drop raw table, rồi chạy SQL rollback 004 theo transaction qua quy trình migration. Nếu dùng migration runner hiện có, xóa duy nhất record `004_check_results.sql` trong `schema_migrations` trong cùng transaction rollback để cho phép reapply. Giữ canonical result/receipt; raw history tái tạo bằng backfill khi reapply. Không chạy rollback 003 trên database đang chứa dữ liệu cần giữ; script roundtrip tổng thể chỉ dùng database tạm riêng.

## Recovery và giao diện

- Lease bị cấp lại cho probe khác giữ cùng target; old lease/heartbeat bị 410. Result matching sau commit trả receipt cũ, không ghi lại raw/outbox. Integration test kiểm tra ACK thất bại và duplicate response; runtime test kiểm tra kill container thật.
- Lỗi HTTP 401/403/404 khi refresh snapshot xóa dữ liệu và dừng polling/SSE tương ứng; lỗi network/5xx giữ snapshot với cảnh báo. Stream unauthorized cũng xóa dữ liệu. Scope key và generation guards bỏ response của scope cũ.
- Bộ test browser đi qua API/worker/Go thật để tạo dữ liệu, sau đó inject lỗi mạng/HTTP 403 ở snapshot request để kiểm chứng UI. Đây không phải bằng chứng Cognito hoặc AWS network hoạt động.

## Artifact và hạ tầng

Local image đã build: `argus-probe:week3-day2`, Linux/amd64, non-root. Archive: `agents/probe/bin/week3-day2.tar` (build artifact, nằm trong thư mục ignored). Local manifest digest: `sha256:51861c28593fe0a83a1bc2a8e20eef698a1a8249ccdb7ca0ed2611acae095922`. Config digest trích xuất từ archive: `sha256:5da707b9fe7480d87bf3b720b5194e650c8b6e19ad1341e48dc6af99d9f9fa15`. Digest AWS phải lấy từ pipeline sau khi push; không tự coi local digest là artifact đã có trên ECR.

Terraform nằm ở `infra/terraform/probes`, dùng state riêng để tránh đụng root control plane và optional task definitions cũ. Module tạo VPC/egress-only security group, ECR, logs, ECS cluster/task/service, IAM execution role và token secret references từng region. Tasks không có DB/Redis credentials. Chi tiết bootstrap, release, rollback và điều kiện AWS: `infra/terraform/probes/README.md`.

## Bàn giao cho năm người và blocker ngày 3

| Owner | Đầu ra ngày 2 | Cần chốt trước integration ngày 3 |
|---|---|---|
| Người 1 | Invariants transaction/quorum giữ nguyên; source review cho raw identity và regional wiring | Review thay đổi trong Git/PR thực và xác nhận thứ tự migration/deploy |
| Người 2 | Migration, maintenance, batch backfill và populated rollback tests | Kế hoạch rollout DB staging, migration role và maintenance metrics |
| Người 3 | Failover tests, image/archive và real-container crash drill | Probe identities/token registration và phiên bản artifact trên ECR |
| Người 4 | Network/reconnect/permission fixes cùng component/browser tests | Kiểm tra UI trên staging endpoint thật sau deploy |
| Người 5 | Terraform ba providers/module dùng lại, pipeline distribution, readiness/runbook | AWS account/backend, HTTPS endpoint, secret/KMS ARNs, OIDC role, protected environments; cung cấp trước buổi integration |

Workspace chưa có Git metadata; không có commit/merge hoặc approval của thành viên khác được xác nhận. AWS account/endpoint/secrets/OIDC không được suy đoán từ fixtures. Mock Terraform pass không thay thế AWS plan/apply, ECS task readiness hoặc CloudWatch alert thử kích hoạt. Load 1.000 monitor và retention nằm ngoài acceptance ngày 2.

## Tự kiểm tra

Từ repository root, dùng database/Redis local riêng và dependency hiện có:

```powershell
$env:NODE_ENV='test'
$env:AUTH_MODE='mock'
$env:DATABASE_URL='postgres://argus:argus@127.0.0.1:5432/argus'
$env:REDIS_URL='redis://127.0.0.1:6379'
pnpm --filter @argus/api db:migrate
pnpm verify
pnpm test:migrations
pnpm --filter @argus/api db:backfill-raw
```

`pnpm verify` bao gồm populated raw rollback/backfill test khi DATABASE_URL có mặt, và pipeline integration khi cả DB/Redis có mặt. Không tính test skip là đạt. Backfill CLI không xóa dữ liệu; có thể chạy lại.

Runtime: cần API mock-auth tại localhost:4000, worker bật scheduler, probe image đã build, và test target. Bản kiểm chứng dùng PostgreSQL/Redis của Compose project riêng `argus-week3-day1` đang được giữ từ ngày 1; API/worker/web/target chạy trên host và probe chạy Docker. Tránh tạo Compose project mới dùng cùng port khi project cũ đang chạy.

```powershell
docker build --platform linux/amd64 --provenance=false -f agents/probe/Dockerfile -t argus-probe:week3-day2 .
$env:ARGUS_SMOKE_LOCAL='true'
$env:ARGUS_SMOKE_TARGET='http://host.docker.internal:8080/check'
pnpm test:week3-smoke
pnpm test:probe-recovery
$env:ARGUS_WEEK3_RUNTIME='true'
pnpm --filter @argus/web exec playwright test e2e/week3-regional.spec.ts e2e/execution-pipeline.spec.ts
```

Smoke cần ba probe chạy và đăng ký trước; recovery script tự tạo hai probe/region/test target riêng, kill đúng container của nó, chờ lease 45 giây và xóa fixtures khi xong. Nó dùng localhost:4000/6379 và Docker Desktop `host.docker.internal`; không chạy với API/database bên ngoài. Test-target `/check` phải đang healthy cho smoke.

## Bằng chứng đã quan sát

| Kiểm tra | Kết quả |
|---|---|
| `pnpm verify` với PostgreSQL/Redis | PASS: lint/typecheck/contracts/build; 51 domain, 37 API, 20 web, 2 target, 1 release tests; 1 load test skip do chưa bật load gate |
| `pnpm test:migrations` | PASS: empty DB rollback/reapply 003 + 004 |
| Populated raw rollback/backfill | PASS: hai vòng rollback/reapply, UTC microsecond, concurrent batches và canonical receipt giữ nguyên |
| Backfill CLI chạy hai lần | PASS, lần nào cũng `inserted: 0` trên bộ dữ liệu hiện tại |
| Go unit tests trong image build | PASS; image build hoàn tất |
| Three-region HTTP smoke với image mới | PASS, có raw copies/snapshot/heartbeat/SSE và tenant/probe-auth checks |
| Real probe recovery | PASS: kill container trong HTTP check, probe khác reclaim tự nhiên, owner cũ HTTP 410, một raw result |
| Browser execution-pipeline | PASS, 2 tests |
| Browser regional runtime + network/permission injection | PASS sau khi sửa vị trí cài fake clock trước mount; 1 test, không có pageerror; đã xem screenshot mobile |
| Terraform fmt/validate + mock tests | PASS, 2 mock tests; provider 6.63.0 cảnh báo deprecation `aws_region.name` |
| Release/archive tooling | Release consistency test PASS; archive config digest được trích xuất/đối chiếu trên image thật; publisher syntax checked, chưa chạy AWS publishing |

`go vet ./...` và `go test -race ./...` đã PASS trong container Go hiện có. Kiểm tra bổ sung bằng database tạm chưa có migration xác nhận worker đóng connection/app và thoát mã 1 ngay, thay vì treo lúc startup; API đã build lại sau sửa này. Không có deployment, registry push hay sửa secrets AWS trong phiên này.
