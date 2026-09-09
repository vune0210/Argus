# Tuần 3 / ngày 1 — Contracts và chuẩn bị ba region

Tài liệu bàn giao dựa trên source hiện có và kiểm thử của phiên triển khai này. Không coi Compose là ba AWS region thật. Workspace không có `.git`, vì vậy không có commit/merge hoặc phê duyệt của thành viên khác để xác nhận.

## 1. Trạng thái và quyết định đã khóa

- Tái sử dụng scheduler, PostgreSQL outbox, regional Redis Streams, lease, ingestion, evaluator và SSE tuần 2. Không thêm scheduler thứ hai và không loại bỏ incident/flapping đã có.
- HTTP là check đã được nối trọn luồng trong contracts hiện tại. TCP chưa có monitor contract/producer hoàn chỉnh; không ghi nhận TCP đã sẵn sàng chỉ từ kế hoạch tổng thể.
- Một `Execution` là một lượt kiểm tra của monitor/config version; một `execution_target` cho mỗi region. `ProbeJob` v0.1 không chứa region; `ProbeLease.targetRegion` và danh tính probe quyết định region, `ProbeResult.region` phải khớp.
- Job/result v0.1 và OpenAPI v0.2 giữ tương thích. Bổ sung `GET /api/v1/monitors/{id}/snapshot`, các type generated `MonitorSnapshot`/`RegionSnapshot`, và invalidation `probe.result_received`.
- SSE dùng envelope hiện có. Schema tên event nay chấp nhận dấu `_`, phù hợp các event đã có như `monitor.health_changed` và `system.resync_required`.
- Contracts được cập nhật và kiểm tra trước consumer. Việc merge/review bởi người khác vẫn là bước của team khi đưa workspace vào repository thật.

## 2. Giao diện và quy tắc dữ liệu

### Scheduler / lease / ingestion

| Bước | Owner module | Quy tắc hiện có cần giữ |
|---|---|---|
| Tạo execution | Worker `schedule` / Người 3 | Lock monitor `SKIP LOCKED`; execution + targets + outbox cùng transaction. Worker mới chạy scheduler; API không chạy loop. |
| Publish | Worker `dispatch` / Người 3 | Stream `argus:v1:probe-jobs:{region}`, group `argus-probes-v1`. Payload transport là target ID; config lấy từ PostgreSQL. Publish lỗi giữ durable work để thử lại. |
| Lease | API `lease` / Người 3 + 2 | Lease 45 giây, không vượt deadline execution 150 giây; tối đa ba lần cấp thực. Probe dùng HTTPS long-poll, không kết nối Redis. |
| Heartbeat | Probe + `ProbeAuthGuard` / Người 3 + 2 | Mỗi request xác thực cập nhật `last_seen_at`; lease heartbeat gia hạn trong deadline. Không nhầm SSE keepalive với heartbeat probe. |
| Nhận result | API `ingest` / Người 2 | Kiểm tra lease owner, execution, monitor, tenant, region và version từ DB; payload không cấp quyền truy cập. |
| Commit | API `ingest` / Người 2 | Result + target completed + `probe.result_received` + outbox cùng transaction; duplicate giống hệt trả receipt cũ, không tạo event mới. |
| ACK | API sau commit / Người 3 + 2 | ACK lỗi không hủy receipt. Transport có thể giao lại, tác động nghiệp vụ không lặp. |
| Reclaim | Redis take + worker repair / Người 3 | Reclaim sau 45 giây; lease ID fence owner cũ. Target đã hoàn tất có thể ACK lại; bỏ transport entry không hợp lệ không có nghĩa chấp nhận result. |
| Evaluate | Finalizer / Người 1 + 2 | Chỉ execution SCHEDULED, version hiện tại và sequence mới được cập nhật health. |

Scheduler hiện bỏ qua các interval đã lỡ và đặt lịch tiếp theo từ thời điểm chạy; không backfill. Dùng cơ chế lock hiện có để ngăn worker tạo trùng; không suy ra idempotency từ timestamp do probe cung cấp.

**Quorum giữ theo code tuần 2:** hai FAIL trong ba region là `QUORUM_FAILURE`; có region thiếu và chưa đủ FAIL là `INSUFFICIENT_RESULTS`; một FAIL khi đủ result là `SINGLE_REGION_FAILURE`; tất cả PASS mới là `QUORUM_PASS`. Hai PASS và một thiếu không phải clean pass. Hai failure liên tiếp để DOWN, hai clean pass để phục hồi. Bộ `week3-evaluator.json` khóa 11 tình huống, gồm duplicate evaluation, old sequence, old config và diagnostic.

**Chống trùng / partition:** schema hiện có `UNIQUE(execution_id, region)` trên targets và `UNIQUE(target_id)` trên `probe_results`; đây là khóa một phiếu/region, mạnh hơn chỉ unique execution/probe khi đổi probe. Ngày 1 không tạo bảng `check_results` song song hoặc chạy migration phá dữ liệu. Thiết kế ngày 2: giữ target + receipt authority không partition; dữ liệu raw partition theo ngày chỉ là lớp lưu trữ lịch sử. Receipt/canonical result phải còn đủ để so sánh duplicate qua nửa đêm. Người 2 triển khai migration/backfill/roundtrip sau khi Người 1 review; retention chưa chạy trong ngày 1.

### Snapshot / SSE / dashboard

- Snapshot xác thực membership và monitor theo tenant, trả 404 cho monitor không thuộc tenant hoặc đã xóa. Một SQL statement đọc health/config/result/heartbeat nhất quán.
- Mỗi region trả accepted result SCHEDULED mới nhất của config hiện tại, sắp theo execution sequence, không theo thời điểm arrival. Diagnostic nằm trong execution timeline, không thay số liệu current health.
- Thiếu result: `outcome`, `latencyMs`, thời gian và execution identity đều `null`; `freshness=NO_DATA`. Latency thật bằng 0 vẫn là `0 ms`.
- Result stale khi vượt `scheduledAt + intervalSeconds + 150s`; đây là chỉ báo độ mới dữ liệu, không tự thay health.
- Heartbeat chỉ từ probe gần nhất được gán cho chính monitor/region đó; không lộ danh sách fleet, token, digest hoặc probe của tenant khác. `ALIVE` khi probe ACTIVE được thấy trong 60 giây; có lịch sử nhưng hết hạn/disabled là `STALE`, chưa thấy là `UNKNOWN`.
- Frontend lấy snapshot khi vào trang, nhận invalidation, reconnect thành công; refresh 15 giây để heartbeat có thể chuyển stale khi không có event. Không có event `probe.heartbeat` giả tạo.
- SSE: tenant membership kiểm tra lại trong stream; UUID `Last-Event-ID` là cursor opaque, không so sánh từ điển. Initial/unknown/expired cursor yêu cầu resync; frontend refetch REST, không áp payload event trực tiếp làm lùi state.
- Frontend coalesce yêu cầu refresh và remount state theo organization/monitor; hủy stream cũ, bỏ response cũ khi đổi scope. Mất quyền stream xóa snapshot; mất kết nối có thông báo rõ.

Fixtures dùng chung: `packages/contracts/examples/week3-three-region.json` chứa hai organization mẫu, ba lease/result, receipt, snapshot empty/healthy/failure/stale/missing và SSE. Fixture cố định dùng cho contract/UI/Go tests, không gửi thẳng vào API đang chạy vì timestamp và lease đã cố định. Smoke script tạo dữ liệu runtime riêng.

## 3. Bàn giao cho năm người / việc tiếp theo

| Người | Đầu ra ngày 1 | Bắt đầu ngày 2 | Phụ thuộc |
|---|---|---|---|
| 1 — Lead | Quy tắc execution/quorum/ordering; 11 evaluator fixtures và tests; review transaction/tenant boundary | Review migration partition và các trường hợp superseded lease; duyệt contracts trong repository thật | Người 2 trình migration; team cấp repo thực |
| 2 — Backend | Snapshot API có tenant guard; generated types; invalidation transactional; ingestion/snapshot integration tests | Thực hiện raw partition với receipt authority giữ nguyên, test replay qua ngày và ingest đồng thời | Quy tắc storage phía trên |
| 3 — Probe | Shared JSON được Go decode/test; scheduler/reclaim hiện có được giữ; ba config managed mẫu | Nối cấu hình image digest/secrets/network vào deployment từng region, kiểm thử kill/reclaim theo môi trường | Người 5 cung cấp hạ tầng thực |
| 4 — Frontend | Live overview đã nối API thật; fixture states; reconnect và scope-change tests | Hoàn thiện trải nghiệm số liệu theo phản hồi integration, kiểm tra trên staging thật | Endpoint staging và dữ liệu ba region |
| 5 — QA/SRE | Test target chuyển healthy/slow/down; smoke script; readiness và test matrix | Bổ sung providers/module/service/network từng AWS region, image availability và alerts | AWS account, deployment URL, secret references và pipeline |

Mỗi người giữ một hạng mục lớn đang làm. Contracts/security do Người 1 review; PR của Người 1 do Người 2 hoặc 3 review. Không ghi nhận phê duyệt cá nhân thay cho team.

## 4. Readiness hạ tầng — ba region

| Kiểm tra | Bằng chứng source | Trạng thái / owner |
|---|---|---|
| Region và probe identity | `infra/probes/ap-southeast-1.env.example`, `ap-northeast-1.env.example`, `eu-central-1.env.example` | Có mẫu, Người 3 điền endpoint thực và mount token riêng |
| HTTP/S và private targets | Go config/executor guard; mẫu staging dùng HTTPS và `ARGUS_ALLOW_PRIVATE_TARGETS=false` | Có guard; handshake/egress AWS chưa kiểm chứng, Người 5 |
| Image/version | Build từ `agents/probe/Dockerfile`; Go fixture đi vào build stage | Chưa có image digest/ECR artifact đã xác nhận cho staging, Người 3 + 5 |
| AWS deployment thực | Terraform hiện chỉ có một provider `aws_region`; task definitions theo map không tự thành ba AWS region | BLOCKER trước integration thứ Tư: Người 5 bổ sung provider/module/service và egress networking từng region |
| Running ECS services | `execution.tf` tạo task definitions, không tạo running services | Chưa ready cho staging; Người 5 xử lý ngày 2 |
| Secrets / registration | CLI `probe:register`, KMS/Secrets Manager references và `ARGUS_TOKEN_FILE` hỗ trợ | Chưa xác nhận private references/registration trên AWS; Người 2 + 5 |
| Observability | Worker gauges scheduler lag/queue/outbox; API latency/duplicate counters; probe last_seen | Còn regional heartbeat/pending dashboards và cảnh báo AWS; Người 5 |
| Staging phiên bản/URL | Không có thông tin staging đã xác thực trong workspace | Chưa ghi nhận smoke staging hoặc AWS approval; local evidence tách riêng bên dưới |

Không dùng development probe tokens ở staging. Các `.env.example` không chứa token; đường dẫn token file là điểm mount, không phải secret đã tồn tại. Terraform Secrets Manager injection qua `ARGUS_TOKEN` vẫn được probe hỗ trợ; chọn cơ chế mount/file khi dùng mẫu standalone.

## 5. Test matrix và tự kiểm tra

| Tình huống | Kiểm thử thực thi |
|---|---|
| Go/TS/API cùng hiểu lease/result/receipt | `pnpm contracts:check`; Go `TestSharedThreeRegionFixtures` |
| Quorum, missing, duplicate, out-of-order, config cũ | Domain fixture suite và pipeline integration |
| Ingest duplicate, sai identity, reclaim, ACK sau commit | Pipeline integration; kiểm tra receipt, events, pending jobs |
| Snapshot tenant B không thấy tenant A, heartbeat không lộ fleet | Pipeline integration và HTTP smoke |
| Result đến trễ không làm lùi snapshot; diagnostic/config cũ không xuất hiện như current result | Pipeline integration |
| Empty/fail/stale/missing; latency null khác 0 | Regional dashboard component tests |
| Reconnect/refetch, đổi organization, response cũ, mất quyền | Regional dashboard tests |
| Healthy/slow/down/recovery cùng URL | `pnpm test:target` |
| Scheduled Go probe → ingestion → snapshot → SSE | `pnpm test:week3-smoke`, chạy một region để kiểm tra baseline rồi ba region local |
| Nửa đêm/partition raw | Chưa triển khai partition; là acceptance bắt buộc cho migration ngày 2 |
| AWS three-region và alerts | Chưa chạy; cần giải quyết readiness blockers phía trên |

Chạy tại workspace root với dependency đã cài:

```powershell
pnpm verify
```

Để bao gồm integration: dùng PostgreSQL/Redis test riêng, migration hiện có; set `NODE_ENV=test`, `AUTH_MODE=mock`, `DATABASE_URL`, `REDIS_URL`, rồi `pnpm --filter @argus/api db:migrate` trước `pnpm verify`. Không dùng database staging/production cho suite mutation.

Full local Compose (lệnh dành cho người tự chạy; bằng chứng phiên hiện tại ghi riêng):

```powershell
docker compose up -d --build --wait
$env:ARGUS_SMOKE_LOCAL='true'
$env:DATABASE_URL='postgres://argus:argus@127.0.0.1:5432/argus'
pnpm test:week3-smoke
```

Smoke tự tạo/xóa hai tenant riêng; cần mock auth, worker scheduler bật và probe đã đăng ký. Mặc định monitor trỏ `http://test-target:8080/check`. Khi API/target chạy trên host và probe ở Docker, đặt `ARGUS_SMOKE_TARGET=http://host.docker.internal:8080/check`. Dùng `ARGUS_SMOKE_REGIONS=ap-southeast-1` để kiểm tra một region, xóa biến để chạy đủ ba.

Test target local: monitor trỏ `/check`; `POST /__control?mode=slow&delayMs=1500`, `POST /__control?mode=down`, hoặc `POST /__control?mode=healthy`. Control chỉ bật khi `ARGUS_TEST_CONTROL=true`; down trả HTTP 503, còn test process/container vẫn sống. Kill container là bài kiểm tra network failure riêng.

## 6. Bằng chứng phiên triển khai

| Kiểm tra đã quan sát | Kết quả |
|---|---|
| `pnpm install --no-frozen-lockfile` với `CI=true`, sau khi người dùng cho phép | Thành công; đồng bộ dependency/lockfile, API resolve được Redis và domain workspace |
| `pnpm contracts:check` | PASS; generated TS/Go và fixtures khớp schema |
| Domain suite | PASS, 51 tests, gồm 11 evaluator fixtures ngày 1 |
| API unit suite | PASS, 20 tests |
| API pipeline integration trên PostgreSQL/Redis riêng | PASS, 10 tests; bao gồm snapshot, tenant, duplicate, ordering, reclaim và identity |
| Web component/SSE suite | PASS, 14 tests |
| `pnpm test:target` | PASS, 2 tests |
| Go `go test -race ./...` trong image `golang:1.26.6-bookworm` | PASS cho contracts, controlplane và executor |
| `pnpm test:week3-smoke`, một region rồi ba region | PASS với Go binary build từ source, API/worker thật, PostgreSQL/Redis local; không mock probe/result |
| Playwright execution-pipeline + week3-regional | PASS, 3 tests; một test dùng web proxy/API/Go thật, hai test còn lại mock API/SSE |
| Screenshot desktop/mobile của test runtime | Đã xem; ba regional cards có PASS và heartbeat; không có browser pageerror |

API integration từng gặp lỗi do synthetic timestamp dùng clock host khác clock DB; fixture đã đổi sang `lease.job.scheduledAt` để kiểm thử xác định, không nới validation production. Suite 10 tests sau sửa đã chạy thành công.

Khi phiên tiếp tục ngày 7/9, Docker engine không còn khả dụng; Node API/worker/test-target của lần kiểm chứng trước không còn chạy. Bằng chứng integration/runtime phía trên thuộc lần kiểm chứng local đã hoàn tất trước đó. Lần chạy workspace checks sau đó không đặt DATABASE_URL/REDIS_URL nên 14 integration/load tests được skip; không coi skip là PASS. Ba probe container đã được stop sau runtime tests; volume test và container đã dừng được giữ lại. Không có staging/AWS deployment, image scan, Terraform apply, Git merge hay phê duyệt của team được xác nhận.
