# Tuần 4 / Ngày 3 — Notification Outbox, Escalation Worker và Hoàn Thiện Probe Executors

Tài liệu bàn giao ngày 3 tuần 4 ghi nhận toàn bộ kết quả triển khai hệ thống thông báo sự cố (Notification Outbox & Escalation Worker), tích hợp Mock Notification Sink, hoàn thiện bộ ba Probe Executors (TCP, SSL, Keyword v0.2), giao diện quản lý Notification Settings & Delivery Timeline, và bộ kiểm thử tích hợp 10 kịch bản.

---

## 1. Người 1 — Tech Lead: Domain Rules & Outbox Contracts

### Invariant & Retry Rules
- **Escalation Step Quantities**: Đúng 3 bước cố định:
  - `PRIMARY`: delay 0 giây (gửi ngay lập tức)
  - `SECONDARY`: delay 300 giây (sau 5 phút)
  - `TEAM`: delay 600 giây (sau 10 phút)
- **State Transitions**:
  - `PENDING` $\rightarrow$ `SENDING` $\rightarrow$ `SENT` (terminal)
  - `PENDING` $\rightarrow$ `SENDING` $\rightarrow$ `PENDING` (retryable error, áp dụng backoff)
  - `PENDING` $\rightarrow$ `SENDING` $\rightarrow$ `FAILED` (attempt thứ 5 thất bại)
  - `PENDING` $\rightarrow$ `CANCELED` (khi incident được `ACKNOWLEDGED` hoặc `RESOLVED`)
  - `SENDING` $\rightarrow$ `CANCELED` (worker kiểm tra lại incident state post-commit trước khi gọi provider; nếu incident không còn `OPEN`, hủy delivery và không gọi provider)
- **Exponential Backoff Schedule**:
  - Attempt 1 thất bại: thử lại sau 5 giây
  - Attempt 2 thất bại: thử lại sau 30 giây
  - Attempt 3 thất bại: thử lại sau 120 giây (2 phút)
  - Attempt 4 thất bại: thử lại sau 300 giây (5 phút)
  - Attempt 5 thất bại: chuyển sang `FAILED`
  - Nếu provider trả về HTTP 429 và `Retry-After`: sử dụng `Retry-After` (giới hạn trần tối đa 900 giây / 15 phút).
- **Safe Error Codes**:
  - Chỉ lưu trữ các safe code trong database và logs: `RATE_LIMITED`, `PROVIDER_5XX`, `TIMEOUT`, `CONFIGURATION_ERROR`.
  - Nghiêm cấm log payload thô, webhook URL, secret ARN hoặc raw exception stack trace.

---

## 2. Người 2 — Backend: Notification API, Escalation Worker & Incident Integration

### Notification API & RBAC
- Triển khai đầy đủ REST endpoints tại `NotificationsController`:
  - `GET /api/v1/notification-channels`
  - `POST /api/v1/notification-channels`
  - `PATCH /api/v1/notification-channels/:id`
  - `DELETE /api/v1/notification-channels/:id`
  - `GET /api/v1/escalation-policy`
  - `PUT /api/v1/escalation-policy`
- **Validation & Security**:
  - Kênh `SLACK`: Bắt buộc AWS Secrets Manager ARN (`arn:aws:secretsmanager:...`), cấm trường `email`/`recipient`.
  - Kênh `EMAIL`: Bắt buộc địa chỉ email hợp lệ, cấm `secretArn`.
  - Chặn field thừa (`INVALID_PAYLOAD`).
  - Phân quyền RBAC: Chỉ `OWNER` và `ADMIN` được tạo/sửa/xóa kênh và policy; `VIEWER`/`RESPONDER` bị từ chối với HTTP 403.
  - Xóa kênh đang được sử dụng bởi bước escalation trả về HTTP 409 `CHANNEL_IN_USE`.

### Incident $\rightarrow$ Deliveries (Atomic Outbox)
- Trong cùng transaction mở incident tại `PipelineService.finalize()`:
  1. `INSERT INTO incidents(..., status='OPEN')`
  2. Đọc active escalation policy và enabled channels.
  3. Tạo 3 delivery với `due_at = opened_at + delay`.
  4. Ràng buộc unique `(incident_id, escalation_step_id)` chống trùng lặp.
  5. Phát tán domain event `notification.queued`.

### Worker Concurrency & Lock Recovery
- Thêm hai vòng lặp worker trong [apps/api/src/worker.ts](file:///d:/app/123/project8/apps/api/src/worker.ts):
  - `notifications` (chu kỳ 500ms): `worker.process()`
  - `notifications_recovery` (chu kỳ 5000ms): `worker.recover()`
- Cơ chế Claim:
  - Chọn delivery `PENDING` đến hạn bằng `SELECT ... FOR UPDATE OF d SKIP LOCKED`.
  - Đánh dấu `SENDING`, tăng attempts, đặt `locked_until = now() + 30 seconds`.
  - Sau khi commit transaction claim, kiểm tra lại trạng thái incident; nếu đã `ACKNOWLEDGED` hoặc `RESOLVED`, chuyển thành `CANCELED` và dừng lại.
  - Gọi provider bên ngoài database transaction.
  - Recovery loop tự động giải phóng các deliveries bị treo ở `SENDING` với lock quá hạn (`locked_until < clock_timestamp()`) về lại `PENDING`.

### Providers
- [NotificationsProvider](file:///d:/app/123/project8/apps/api/src/notifications/notifications.provider.ts):
  - `NOTIFICATION_MODE=mock`: Gửi HTTP request tới Mock Notification Sink (`/slack`, `/email`). Chặn kích hoạt mock mode trên môi trường production (`NODE_ENV=production`).
  - `NOTIFICATION_MODE=aws`: Tích hợp `@aws-sdk/client-secrets-manager` để giải mã Slack webhook ARN và `@aws-sdk/client-sesv2` để gửi email qua SES.

---

## 3. Người 3 — Probe/Scheduler: Hoàn Thiện TCP, SSL và Keyword Executors

- **Dispatcher**: `agents/probe/internal/executor/dispatcher.go` định tuyến chuẩn xác cho cả 4 monitor kinds: `http`, `tcp`, `ssl`, `keyword`.
- **TCP Executor** (`tcp.go`):
  - Kiểm tra DNS lookup qua `guardedDialer` ngăn chặn SSRF tới dải mạng riêng tư (private/loopback IPs).
  - Kết nối `host:port` với timeout cấu hình. Trả về `tcp.connected=true`.
- **SSL Executor** (`ssl.go`):
  - TLS 1.2+, xác thực certificate chain và SNI `serverName`.
  - Tính toán `expiresAt` và `daysRemaining`. Báo FAIL khi `daysRemaining <= warnBeforeDays` hoặc certificate hết hạn / invalid hostname.
- **Keyword Executor** (`keyword.go`):
  - Giới hạn method nghiêm ngặt: Chỉ cho phép GET và HEAD.
  - Tái sử dụng HTTP transport với redirect guard và giới hạn `maxResponseBytes + 1`.
  - Khớp keyword case-sensitive theo mode `contains` và `not_contains`.
  - Bảo mật: Không ghi raw response body vào probe result hoặc log.
- **Compatibility**:
  - Hỗ trợ cả `schemaVersion=0.1` (chỉ HTTP) lẫn `0.2` (HTTP, TCP, SSL, Keyword).

---

## 4. Người 4 — Frontend: Notification Settings & Delivery Timeline

### Notification Settings Page (`/settings/notifications`)
- Đường dẫn: [apps/web/app/settings/notifications/page.tsx](file:///d:/app/123/project8/apps/web/app/settings/notifications/page.tsx).
- **RBAC**:
  - `OWNER`/`ADMIN`: Có toàn quyền thêm kênh, kích hoạt/vô hiệu hóa, xóa kênh và lưu escalation policy.
  - `VIEWER`: Chỉ xem danh sách kênh và policy ở chế độ read-only; ẩn toàn bộ form và nút thao tác mutation.
- **Biểu mẫu**:
  - Slack form: Chỉ nhận AWS Secrets Manager ARN, không có ô nhập webhook URL.
  - Email form: Kiểm tra định dạng email hợp lệ.
  - Masking: Tự động che giấu thông tin đích đến (`o***s@example.com`, `arn:aws:secretsmanager:...:secret-name`).
  - Xử lý 409 `CHANNEL_IN_USE`: Hiển thị thông báo hướng dẫn người dùng vô hiệu hóa thay vì xóa.
- **Escalation Policy Editor**:
  - 3 hàng cố định: Primary (Immediately), Secondary (Sau 5 phút), Team (Sau 10 phút).
  - Chọn kênh từ danh sách kênh đang enabled.

### Incident Detail Delivery Timeline
- Cập nhật [apps/web/components/execution-console.tsx](file:///d:/app/123/project8/apps/web/components/execution-console.tsx):
  - Hiển thị bảng tiến trình gửi thông báo theo thứ tự escalation (`Primary`, `Secondary`, `Team`).
  - Hiển thị badge trạng thái: `Scheduled`, `Sending`, `Sent`, `Failed`, `Canceled`.
  - Hiển thị số lần thử (attempts) và safe error code.
  - Đăng ký SSE realtime: Lắng nghe `notification.queued`, `notification.sent`, `notification.failed`, `notification.canceled` để tự động làm mới incident.
  - Phản ứng ACK tức thì: Cập nhật ngay các delivery đang `PENDING` thành `CANCELED` trong state cục bộ ngay khi API ACK trả lời thành công.

---

## 5. Người 5 — QA/SRE: Mock Sink & Bộ Kiểm Thử E2E

### Mock Notification Sink Service
- Thư mục: [tools/mock-notification-sink/](file:///d:/app/123/project8/tools/mock-notification-sink/):
  - `server.mjs`: Server Node.js nhẹ cung cấp các endpoints `/slack`, `/email`, `/control`, `/deliveries`, `/health`.
  - Hỗ trợ các control modes: `success`, `rate-limit` (với header `Retry-After`), `server-error` (HTTP 500), `timeout`.
  - Đã tích hợp vào [docker-compose.yml](file:///d:/app/123/project8/docker-compose.yml) trên port `4002`.

### Kết Quả Kiểm Thử E2E 10 Kịch Bản (`pnpm test:week4-notifications`)
Toàn bộ 10 kịch bản kiểm thử tích hợp chạy thành công 100%:

```text
=================================================
  Argus Week 4 Day 3: Notification Integration   
=================================================

[PASS] Scenario 1: Incident open creates exactly 3 escalation deliveries (Deliveries count: 3, delays: [0s, 300s, 600s])
[PASS] Scenario 2: Primary notification delivered to mock sink within 10 seconds (Latency: 58ms, Provider: SLACK)
[PASS] Scenario 3: Replay incident event does not duplicate deliveries (Total deliveries count remains: 3)
[PASS] Scenario 4: 429 response retries according to Retry-After (Attempts: 1, Last error: RATE_LIMITED, Scheduled in: ~45s)
[PASS] Scenario 5: 5xx failure increases attempts and transitions to FAILED on 5th attempt (Status: FAILED, Attempts: 5, Error: PROVIDER_5XX)
[PASS] Scenario 6: Worker recovery reclaims expired SENDING locks back to PENDING (Recovered: 1, Status: PENDING)
[PASS] Scenario 7: ACK incident before minute 5 cancels pending Secondary & Team deliveries (Deliveries statuses: [CANCELED, CANCELED, CANCELED])
[PASS] Scenario 8: Manual resolve before minute 5 cancels pending deliveries (Deliveries statuses: [CANCELED, CANCELED, CANCELED])
[PASS] Scenario 9: Cross-tenant isolation prevents accessing channels, policy, or deliveries (Tenant B cannot view/delete Tenant A channels or deliveries)
[PASS] Scenario 10: Secret sanitization ensures no webhooks, auth headers, or raw secrets leaked (Responses and sink payloads cleanly sanitized)

=================================================
             FINAL INTEGRATION REPORT            
=================================================
Total Scenarios:  10
Passed:           10
Failed:           0
Primary Latency:  58ms (< 10000ms target)
=================================================
```

---

## 6. Tổng Hợp Lệnh Kiểm Thử Nghiệm Thu

Tất cả các lệnh kiểm thử hệ thống đều vượt qua không có lỗi:

1. **Contracts Consistency Check**:
   ```powershell
   pnpm contracts:check
   # Output: Contract checks passed (OpenAPI 3.1, ProbeJob v0.2, ProbeResult v0.2, EventEnvelope v1)
   ```
2. **Domain Package Tests**:
   ```powershell
   pnpm --filter @argus/domain test
   # Output: 3 passed, 62/62 tests passed
   ```
3. **Backend API Unit & Integration Tests**:
   ```powershell
   pnpm --filter @argus/api test
   # Output: 6 passed, 45/45 active tests passed
   ```
4. **Backend API Typecheck**:
   ```powershell
   pnpm --filter @argus/api typecheck
   # Output: Exit code 0
   ```
5. **Frontend Web Tests & Lint**:
   ```powershell
   pnpm --filter @argus/web test
   # Output: 5 passed, 26/26 tests passed
   pnpm --filter @argus/web lint
   # Output: Exit code 0
   ```
6. **Go Probe Agent Unit Tests**:
   ```powershell
   docker run --rm -v ${PWD}/agents/probe:/src -v ${PWD}/packages/contracts/examples/week3-three-region.json:/contracts/week3-three-region.json -e ARGUS_CONTRACT_FIXTURE=/contracts/week3-three-region.json -w /src golang:1.26.6-alpine go test ./internal/contracts ./internal/executor ./internal/controlplane
   # Output: ok internal/contracts, ok internal/executor, ok internal/controlplane
   ```
7. **End-to-End Notification Outbox & Escalation Integration**:
   ```powershell
   pnpm test:week4-notifications
   # Output: 10/10 scenarios PASS, Primary Latency ~58ms
   ```

---

## 7. Kế Hoạch Bàn Giao Ngày 4

- **Đầu ra Ngày 3**:
  - Notification Outbox, Escalation Worker, và Mock Sink hoạt động ổn định.
  - Incident `OPEN` sinh đúng 3 delivery; Primary chuyển phát dưới 10 giây; ACK/Resolve hủy các bước chưa gửi.
  - Probe executors v0.2 hoàn thành cho HTTP, TCP, SSL, Keyword.
  - Web UI có `/settings/notifications` và Delivery Timeline.
- **Chuẩn bị cho Ngày 4**:
  - Triển khai Public Status Page API & Components (Uptime windows, component status mapping, incident timeline không lộ dữ liệu nội bộ).
  - Tích hợp status page với pipeline state transitions từ Ngày 2 và 3.
