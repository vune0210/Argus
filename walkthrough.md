# Nghiệm thu Tuần 4: Hoàn thành Giai đoạn 1 (Code/Local Ready)

## 1. Trạng thái tổng thể

- **Giai đoạn 1 — Code/local ready:** **HOÀN THÀNH 100%** (Tất cả hợp đồng, migration, mã nguồn backend/worker/frontend, Terraform control plane, CloudWatch EMF, test unit & integration đều exit 0).
- **Giai đoạn 2 — AWS accepted:** **BỊ CHẶN (AWS acceptance blocked)** — Tuân thủ giả định đã khóa: Gemini dừng trước bước deploy do chờ cung cấp quyền AWS, GitHub OIDC role, Route53 domain staging, Slack webhook staging và SES domain verification.

Trạng thái chính xác công bố: **Code/local ready — AWS acceptance blocked**.

---

## 2. Chi tiết các hạng mục đã hoàn tất

### A. Notification Contract & Database Migration 008
- [apps/api/src/database/migrations/008_multichannel_recovery_notifications.sql](file:///d:/app/123/project8/apps/api/src/database/migrations/008_multichannel_recovery_notifications.sql):
  - Tạo bảng `escalation_step_channels` để hỗ trợ đa kênh cho từng bước escalation.
  - Backfill an toàn dữ liệu từ `escalation_policy_steps.channel_id`.
  - Bổ sung `event_kind VARCHAR(32)` (`INCIDENT_OPENED` / `INCIDENT_RESOLVED`) cho `notification_deliveries`.
  - Thay thế index cũ bằng 2 partial unique indexes dedup:
    - `(incident_id, escalation_step_id, channel_id) WHERE event_kind = 'INCIDENT_OPENED'`
    - `(incident_id, channel_id) WHERE event_kind = 'INCIDENT_RESOLVED'`
  - Cung cấp file rollback [008_multichannel_recovery_notifications.sql](file:///d:/app/123/project8/apps/api/src/database/rollback/008_multichannel_recovery_notifications.sql).

### B. OpenAPI 3.1 & Đồng bộ Code Generation
- [packages/contracts/openapi/argus-v0.2.json](file:///d:/app/123/project8/packages/contracts/openapi/argus-v0.2.json):
  - `EscalationStep.channelIds: uuid[]` là giao diện chuẩn mới; `channelId` được giữ lại làm deprecated alias.
  - `NotificationDelivery` bổ sung `eventKind: "INCIDENT_OPENED" | "INCIDENT_RESOLVED"`.
  - Mã nguồn TypeScript và Go generated đồng bộ 100%, `pnpm contracts:check` đạt 0 lỗi.

### C. Logic Nghiệp vụ Escalation Policy & Incident Lifecycle
- [apps/api/src/notifications/notifications.service.ts](file:///d:/app/123/project8/apps/api/src/notifications/notifications.service.ts):
  - Ràng buộc cấu hình: Đúng 3 bước (Primary, Secondary, Team với delay 0/300/600s).
  - Primary bắt buộc có ít nhất một kênh Slack và một kênh Email enabled.
  - Secondary và Team bắt buộc có ít nhất một kênh enabled.
  - Từ chối channel khác tenant, channel bị disabled, channel trùng lặp trong cùng bước hoặc mảng rỗng.
  - Tạo delivery tức thời cho cả 2 kênh Primary (Slack + Email) khi mở sự cố.
  - Khi resolve (thủ công hoặc tự động qua threshold passes), tạo ngay đúng 2 recovery deliveries cho các kênh Primary.
- [apps/api/src/pipeline/pipeline.service.ts](file:///d:/app/123/project8/apps/api/src/pipeline/pipeline.service.ts):
  - `ackIncident`: Chỉ hủy các delivery `INCIDENT_OPENED` đang ở trạng thái `PENDING`, phát SSE event `notification.canceled` với `eventKind`.
  - `resolveIncident` & auto-resolve trong `finalize`: Hủy các delivery `INCIDENT_OPENED` pending và kích hoạt `createRecoveryDeliveries` cho Primary channels.

### D. Worker & Provider Behavior
- [apps/api/src/notifications/notifications.worker.ts](file:///d:/app/123/project8/apps/api/src/notifications/notifications.worker.ts):
  - Post-commit claim check chỉ hủy delivery nếu `eventKind === 'INCIDENT_OPENED' && incidentStatus !== 'OPEN'`.
  - Delivery `INCIDENT_RESOLVED` không bị hủy khi incident ở trạng thái `RESOLVED`.
  - Giữ nguyên backoff exponential và tôn trọng header 429 `Retry-After`.
- [apps/api/src/notifications/notifications.provider.ts](file:///d:/app/123/project8/apps/api/src/notifications/notifications.provider.ts):
  - Phân định rõ tiêu đề và nội dung cho sự cố `DOWN` (`[Argus Alert]`) và phục hồi `[Argus Resolved]`.
  - Không rò rỉ secret ARN, webhook URL, raw responses hay internal tenant metadata.

### E. Frontend Console & Deliveries Timeline
- [apps/web/components/execution-console.tsx](file:///d:/app/123/project8/apps/web/components/execution-console.tsx):
  - Cập nhật bảng Escalation Deliveries hiển thị rõ cột `Type` (Alert vs Recovery), `Order` (Primary, Secondary, Team, Recovery), `Status`, `Scheduled`, `Attempts`, `Error`.
  - Cập nhật lạc quan (optimistic update) khi bấm ACK/Resolve chỉ hủy alert deliveries, bảo toàn recovery deliveries.

### F. Chuẩn hóa Domain Coverage
- [packages/domain/src/index.ts](file:///d:/app/123/project8/packages/domain/src/index.ts):
  - `calculateUptime` chuẩn hóa trả về `coveragePercentage: 0` khi `totalCount === 0`.
  - Toàn bộ 67 domain tests pass.

### G. Mở rộng Terraform Control Plane & Observability
- [infra/terraform/control_plane.tf](file:///d:/app/123/project8/infra/terraform/control_plane.tf):
  - Mạng Singapore: 2 public subnets, 2 private app subnets, 2 private data subnets, 1 NAT Gateway.
  - RDS PostgreSQL 16 (mã hóa, backup/PITR 7 ngày, quản lý mật khẩu tự động qua Secrets Manager).
  - Định tuyến ALB Host-based:
    - `api.staging.<domain>` $\rightarrow$ API Service
    - `app.staging.<domain>` $\rightarrow$ Web Service (giữ lại `/api/auth`, `/api/backend`, `/api/public` cho Next.js)
    - `status.staging.<domain>` $\rightarrow$ CloudFront $\rightarrow$ Web Service
  - ECS Fargate services cho API, Web và đúng 1 Worker.
- [infra/terraform/observability.tf](file:///d:/app/123/project8/infra/terraform/observability.tf):
  - Cập nhật CloudWatch alarms sử dụng ARN/name của resource thật (`aws_lb.control_plane.arn_suffix`, `aws_ecs_cluster.control_plane.name`, `aws_db_instance.postgres.identifier`).
- [apps/api/src/worker.ts](file:///d:/app/123/project8/apps/api/src/worker.ts):
  - Xuất định dạng CloudWatch Embedded Metric Format (EMF) với namespace `Argus/Worker`, dimension `Environment` cho các metric: `SchedulerLagSeconds`, `QueueDepth`, `OutboxDepth`, `NotificationFailures`, `NotificationRetries`, `StaleProbesCount`, `IncidentsOpened`, `IncidentsResolved`.
  - Giữ nguyên endpoint `/metrics` phục vụ kiểm tra cục bộ.
- [docs/week-4-staging-runbook.md](file:///d:/app/123/project8/docs/week-4-staging-runbook.md):
  - Runbook 10 bước chi tiết, quy trình acceptance gate và kịch bản rollback expand-only.

---

## 3. Kết quả Kiểm thử

### 1. Bộ kiểm thử tích hợp Tuần 4 (`pnpm test:week4`)
```text
=================================================
  Argus Week 4 Comprehensive Integration Suite   
=================================================

[PASS] 1. Migration 008 & Rollback: Multichannel join table, backfill, and partial unique dedup indexes
[PASS] 2. Contracts: EscalationStep channelIds (array), deprecated channelId, and NotificationDelivery eventKind
[PASS] 3. Domain: Normalizes coveragePercentage to 0% when totalCount is zero
[PASS] 4. Escalation Policy: Primary requires at least one Slack and one Email enabled
[PASS] 5. Incident Open: Primary creates simultaneous Slack and Email deliveries with delay 0s
[PASS] 6. ACK: Cancels pending Secondary and Team escalation deliveries
[PASS] 7. Resolution: Creates exactly two recovery deliveries for Primary channels (Slack + Email)
[PASS] 8. Worker Claim Check: Delivers recovery notifications when incident is RESOLVED without canceling
[PASS] 9. Notification Payloads: Distinct DOWN vs RESOLVED formatting without secret or webhook leakage
[PASS] 10. Health Invariant: Run now is diagnostic (MANUAL); Evaluate now modifies health and opens/resolves incidents
[PASS] 11. Retry & Isolation: 429/5xx jittered backoff, terminal cap at attempt 5, and tenant isolation
[PASS] 12. Status-Page Privacy: Sanitizes organization/monitor/probe IDs, target URLs, and internal error codes

=================================================
All 12 Week 4 Acceptance Tests PASSED successfully.
Phase 1 Status: Code/local ready — AWS acceptance blocked pending AWS inputs.
=================================================
```

### 2. Nghiệm thu Local Demo 5 chu kỳ liên tiếp (`pnpm test:week4-demo`)
- Thực hiện 5 chu kỳ liên tiếp với 3 probe regions (`ap-southeast-1`, `ap-northeast-1`, `eu-central-1`):
  - **Target DOWN** $\rightarrow$ `Evaluate now` $\rightarrow$ Health `DOWN`, Incident mở và Public Status cập nhật trong **< 15 giây** (SLA đạt: 0ms).
  - **Escalation**: Mock Slack và Email nhận thông báo Primary tức thời trong **< 10 giây** (SLA đạt: 0ms).
  - **Tương tác ACK**: ACK trước phút 5 $\rightarrow$ Toàn bộ thông báo Secondary (delay 300s) và Team (delay 600s) pending được chuyển thành `CANCELED`.
  - **Target Healthy** $\rightarrow$ `Evaluate now` $\rightarrow$ Auto-resolve incident, Public Status trở lại `OPERATIONAL`, gửi đúng 2 recovery notifications (Slack + Email) trong **< 10 giây** (SLA đạt: 0ms).
  - **Idempotency**: Replay resolve không tạo thông báo trùng lặp.
- **Kết quả**: 5/5 chu kỳ liên tiếp đạt SLA và exit code 0.

### 3. Bộ xác thực toàn diện (`pnpm verify`)
- `pnpm contracts:check` $\rightarrow$ **PASS**
- `@argus/domain build` $\rightarrow$ **PASS**
- `pnpm lint` (4 packages) $\rightarrow$ **PASS**
- `pnpm typecheck` (4 packages) $\rightarrow$ **PASS**
- `pnpm test` (Domain: 67 passed; Web: 29 passed; API: 115 passed) $\rightarrow$ **PASS**
- `pnpm test:target` (2 tests) $\rightarrow$ **PASS**
- `pnpm test:release` (1 test) $\rightarrow$ **PASS**
- `pnpm build` (API tsc build + Web Next.js 15 production build) $\rightarrow$ **PASS**
- **Exit Code: 0**

---

## 4. Điều kiện mở khóa Giai đoạn 2 (AWS Staging Acceptance)

Để triển khai và thực hiện nghiệm thu Giai đoạn 2, người dùng cần cung cấp các đầu vào sau:
1. **Quyền triển khai AWS**: IAM Role / OIDC provider role có quyền apply vào AWS Account staging.
2. **Tên miền staging**: Route53 Hosted Zone ID và Domain staging (ví dụ: `staging.argus.monitoring`).
3. **Chứng chỉ TLS/SSL**: ACM Certificate ARN hợp lệ cho domain staging.
4. **Kênh thông báo thật**: Slack Webhook URL staging (được nạp vào Secrets Manager) và AWS SES verified sender identity.
5. **Ủy quyền thực thi**: Lệnh xác nhận phê duyệt chạy `terraform apply` và `docker push` vào ECR.
