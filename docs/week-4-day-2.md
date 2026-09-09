# Tuần 4 / Ngày 2 — Triển khai incident lifecycle và nền tảng persistence

Tài liệu bàn giao ngày 2 tuần 4 ghi nhận toàn bộ kết quả triển khai chuỗi vòng đời sự cố (incident lifecycle `OPEN → ACKNOWLEDGED → RESOLVED`), tích hợp persistence, cơ chế hủy thông báo pending khi ACK/Resolve, bộ Go probe skeleton executors (TCP, SSL, Keyword, Dispatcher) và giao diện điều khiển Next.js.

---

## 1. Người 1 — Tech Lead: Invariants & Lifecycle Rules

### Incident Lifecycle Machine
- Trạng thái hợp lệ: `OPEN`, `ACKNOWLEDGED`, `RESOLVED`.
- Transition graph:
  - `OPEN → ACKNOWLEDGED` (Manual ACK bởi Responder trở lên)
  - `OPEN → RESOLVED` (Manual resolve hoặc Auto-recovery)
  - `ACKNOWLEDGED → RESOLVED` (Manual resolve hoặc Auto-recovery)
  - `RESOLVED` là terminal state.
- **Ràng buộc Database Invariant**:
  ```sql
  ALTER TABLE incidents ADD CONSTRAINT incidents_lifecycle_check CHECK (
    (status = 'OPEN' AND acknowledged_at IS NULL AND acknowledged_by IS NULL AND resolved_at IS NULL AND resolved_by IS NULL) OR
    (status = 'ACKNOWLEDGED' AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL AND resolved_at IS NULL AND resolved_by IS NULL) OR
    (status = 'RESOLVED' AND resolved_at IS NOT NULL)
  );
  ```
- **Idempotency & Conflict Rules**:
  - Gặp sự cố đã `ACKNOWLEDGED`, gọi lại `POST /incidents/:id/ack` trả về chi tiết hiện tại (idempotent 200 OK), không emit duplicate event.
  - Gặp sự cố đã `RESOLVED`, gọi lại `POST /incidents/:id/resolve` trả về chi tiết hiện tại (idempotent 200 OK), không emit duplicate event.
  - Gặp sự cố đã `RESOLVED`, gọi `POST /incidents/:id/ack` trả về lỗi 409 Conflict (`INCIDENT_ALREADY_RESOLVED`).
- **Cancellation Boundary**:
  - Khi incident chuyển sang `ACKNOWLEDGED` hoặc `RESOLVED`, mọi notification delivery đang ở trạng thái `PENDING` bị hủy ngay lập tức trong cùng transaction:
    ```sql
    UPDATE notification_deliveries SET status='CANCELED' WHERE incident_id=$1 AND status='PENDING';
    ```

---

## 2. Người 2 — Backend: Incident API & Auto-Recovery

### Migration & Database
- [005_incident_response.sql](file:///d:/app/123/project8/apps/api/src/database/migrations/005_incident_response.sql):
  - Áp dụng an toàn cho database mới lẫn database có sẵn incident cũ.
  - Backfill an toàn: `UPDATE incidents SET status = CASE WHEN resolved_at IS NOT NULL THEN 'RESOLVED' ELSE 'OPEN' END;`.
  - Khóa constraint `incidents_lifecycle_check`.
  - Partial unique index: `CREATE UNIQUE INDEX incidents_one_unresolved ON incidents(monitor_id) WHERE status != 'RESOLVED';`.
- [Rollback 005](file:///d:/app/123/project8/apps/api/src/database/rollback/005_incident_response.sql) hoàn chỉnh.

### RBAC & Endpoints
- [OrganizationsService](file:///d:/app/123/project8/apps/api/src/organizations/organizations.service.ts):
  - Bổ sung `requireIncidentWrite(organizationId, userId)`:
    - Cho phép `OWNER`, `ADMIN`, `RESPONDER`.
    - Chặn `VIEWER` với HTTP 403 `INSUFFICIENT_ROLE`.
- [PipelineController](file:///d:/app/123/project8/apps/api/src/pipeline/pipeline.controller.ts):
  - `POST /api/v1/incidents/:id/ack`
  - `POST /api/v1/incidents/:id/resolve`
- [PipelineService](file:///d:/app/123/project8/apps/api/src/pipeline/pipeline.service.ts):
  - `ackIncident(organizationId, userId, incidentId)`: chạy trong transaction, lock `SELECT ... FOR UPDATE`, cập nhật `ACKNOWLEDGED`, ghi `incident_events` (actor = userId), hủy `PENDING` deliveries, phát tán domain event `incident.acknowledged`.
  - `resolveIncident(organizationId, userId, incidentId)`: chạy trong transaction, lock `SELECT ... FOR UPDATE`, cập nhật `RESOLVED`, ghi `incident_events`, hủy `PENDING` deliveries, phát tán domain event `incident.resolved`.
  - `finalize()` Auto-Recovery: Khi quorum passes phục hồi monitor, câu lệnh UPDATE tìm và resolve incident đang `OPEN` hoặc `ACKNOWLEDGED`:
    ```sql
    UPDATE incidents SET status='RESOLVED', resolved_at=$2, resolved_by=NULL
    WHERE monitor_id=$1 AND status IN ('OPEN', 'ACKNOWLEDGED') RETURNING id;
    ```
    Đồng thời hủy các `PENDING` deliveries và phát tán event `incident.resolved`.

---

## 3. Người 3 — Notification Worker Integration Foundation

- Đảm bảo bảng `notification_deliveries` được truy vấn đầy đủ trong `IncidentDetail` (`deliveries: Array<NotificationDelivery>`).
- Khi tiến hành chuyển trạng thái (ACK hoặc Resolve thủ công / tự động), transaction khóa incident và cập nhật bảng deliveries:
  ```sql
  UPDATE notification_deliveries SET status='CANCELED' WHERE incident_id=$1 AND status='PENDING'
  ```
- Sự kiện SSE:
  - `incident.acknowledged` chứa `{ incidentId, monitorId, acknowledgedBy, acknowledgedAt }`.
  - `incident.resolved` chứa `{ incidentId, monitorId, resolvedBy, resolvedAt, manual: true }` (hoặc do auto recovery).

---

## 4. Người 4 — Probe Agent: Skeleton Executors & Dispatcher

Đã triển khai đầy đủ các bộ executor bằng Go trong `agents/probe/internal/executor`:
- [dispatcher.go](file:///d:/app/123/project8/agents/probe/internal/executor/dispatcher.go):
  - Khởi tạo `NewDispatcher(probeID, region, allowPrivateTarget)`.
  - Điều phối theo `job.Config.Kind`:
    - `""` hoặc `"http"` $\rightarrow$ `HTTPExecutor`
    - `"tcp"` $\rightarrow$ `TCPExecutor`
    - `"ssl"` $\rightarrow$ `SSLExecutor`
    - `"keyword"` $\rightarrow$ `KeywordExecutor`
    - Kind không hợp lệ $\rightarrow$ Trả về `FAIL` với mã lỗi `ASSERTION`.
- [tcp.go](file:///d:/app/123/project8/agents/probe/internal/executor/tcp.go):
  - Kiểm tra kết nối TCP qua `guardedDialer(allowPrivate)` bảo vệ SSRF.
  - Ghi nhận `contracts.TCPResult{Connected: true/false}`.
- [ssl.go](file:///d:/app/123/project8/agents/probe/internal/executor/ssl.go):
  - Bắt tay TLS với `ServerName` và kiểm tra chứng chỉ máy chủ.
  - Tính `daysRemaining` so với `WarnBeforeDays`.
  - Ghi nhận `contracts.SSLResult{ExpiresAt, DaysRemaining}`.
- [keyword.go](file:///d:/app/123/project8/agents/probe/internal/executor/keyword.go):
  - Thực hiện HTTP request, đọc dữ liệu giới hạn `MaxResponseBytes` (default 1MB).
  - Khớp chuỗi theo chế độ `CONTAINS` hoặc `NOT_CONTAINS`, hỗ trợ `caseSensitive`.
  - Ghi nhận `contracts.KeywordResult{StatusCode, ResponseBytes, Matched}`.
- [validation.go](file:///d:/app/123/project8/agents/probe/internal/contracts/validation.go):
  - Hỗ trợ cả schemaVersion `"0.1"` và `"0.2"` (backwards compatible).
  - Kiểm tra tính hợp lệ của từng loại cấu hình monitor tương ứng.
- [dispatcher_test.go](file:///d:/app/123/project8/agents/probe/internal/executor/dispatcher_test.go):
  - Bộ kiểm thử độc lập cho HTTP, TCP, SSL, Keyword và reject unknown kinds.
  - Toàn bộ Go test chạy thành công trong Docker image build.

---

## 5. Người 5 — Frontend & Execution Console

- [lib/api.ts](file:///d:/app/123/project8/apps/web/lib/api.ts):
  - Xuất các hàm `ackIncident(org, id)` và `resolveIncident(org, id)`.
- [execution-console.tsx](file:///d:/app/123/project8/apps/web/components/execution-console.tsx):
  - Đăng ký nhận sự kiện SSE `incident.acknowledged` bên cạnh `incident.opened` và `incident.resolved`.
  - Hiển thị đầy đủ 3 trạng thái của sự cố với status badge (`state-open`, `state-acknowledged`, `state-resolved`).
  - Hiển thị metadata chi tiết: thời gian mở, người và thời gian xác nhận, người và thời gian xử lý xong.
  - Nút **Acknowledge**: hiển thị khi sự cố đang `OPEN` và người dùng không phải `VIEWER`.
  - Nút **Resolve**: hiển thị khi sự cố chưa `RESOLVED` và người dùng không phải `VIEWER`.
  - Khóa nút (disable) khi mutation đang thực thi (`mutating`).
  - Tự động refetch dữ liệu khi nhận mã 409 Conflict.
- [globals.css](file:///d:/app/123/project8/apps/web/app/globals.css):
  - Bổ sung định dạng trực quan cho các badge `.state-open`, `.state-acknowledged`, `.state-resolved` và layout `.incident-detail-card`.

---

## 6. Bằng chứng kiểm thử và nghiệm thu (Test Evidence)

| Hạng mục | Lệnh thực thi | Kết quả |
|---|---|---|
| **Go Probe Build & Tests** | `docker compose build probe` | `ok contracts (0.007s)`, `ok controlplane (0.480s)`, `ok executor (0.248s)`. Binary compiled. |
| **Monorepo Typecheck** | `pnpm typecheck` | 4/4 workspace projects (`contracts`, `domain`, `api`, `web`) hoàn toàn sạch lỗi. |
| **Contracts Schema & Fixtures** | `pnpm contracts:check` | Pass OpenAPI 3.1, ProbeJob v0.2, ProbeResult v0.2, EventEnvelope v1. |
| **Monorepo Linting** | `pnpm lint` | Tất cả các packages pass không có warning/error. |
| **Monorepo Tests** | `pnpm test` | - `domain`: 61/61 passed.<br>- `contracts`: passed.<br>- `web`: 20/20 passed.<br>- `api`: 33 passed, bao gồm 13 tests mới trong `incident-lifecycle.spec.ts`. |
| **Production Build** | `pnpm build` | `contracts`, `domain`, `api` (tsc) và `web` (next build) compile thành công 100%. |

---

## 7. Kế hoạch tiếp nối Ngày 3

- **Notification Worker & Delivery Processor**: Nối worker xử lý hàng đợi `notification_deliveries` với exponential backoff, claim lock an toàn (`FOR UPDATE SKIP LOCKED`) và Slack/Email mock providers.
- **Escalation Trigger**: Triển khai engine tự động tạo `notification_deliveries` theo các bước escalation policy khi incident mở.
- **Probe Live Targets**: Hoàn thiện tích hợp test targets cho TCP, SSL cert rotation và keyword kiểm thử đầu cuối.
