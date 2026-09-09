# Tuần 4 / Ngày 1 — Khóa contracts cho incident, notification, status page và check 0.2

Tài liệu bàn giao ngày 1 tuần 4 xác lập đầy đủ và khóa toàn bộ giao diện kỹ thuật, JSON schemas, OpenAPI specifications, migration designs, domain invariants, fixtures và phân công cho 5 thành viên để từ Ngày 2 có thể triển khai song song độc lập.

---

## 1. Người 1 — Tech Lead: Invariants và compatibility rules

### Incident Invariants
1. **Trigger duy nhất**: Chỉ scheduled executions với 2 quorum failure liên tiếp mới mở incident; manual execution (chẩn đoán "Run now") ghi nhận kết quả nhưng không bao giờ thay đổi health monitor và không mở incident.
2. **Lifecycle transitions**:
   - `OPEN → ACKNOWLEDGED`: Responder trở lên thực hiện qua `POST /incidents/{id}/ack`.
   - `OPEN → RESOLVED`: Responder trở lên giải quyết thủ công qua `POST /incidents/{id}/resolve` hoặc hệ thống auto-resolve khi monitor phục hồi.
   - `ACKNOWLEDGED → RESOLVED`: Responder trở lên giải quyết qua `POST /incidents/{id}/resolve` hoặc hệ thống auto-resolve khi monitor phục hồi.
   - `RESOLVED`: Trạng thái kết thúc; không thể chuyển sang `OPEN` hay `ACKNOWLEDGED`.
   - Idempotency: Gọi nhiều lần ACK hoặc resolve đồng thời trả về cùng kết quả 200 OK và không nhân bản sự kiện.
3. **Giới hạn số lượng**: Mỗi monitor chỉ được phép có tối đa một incident chưa resolve tại một thời điểm (`status != 'RESOLVED'`).
4. **Auto-recovery boundary**: Khi monitor chuyển từ `PENDING_RECOVERY` sang `HEALTHY` (sau 2 clean passes liên tiếp), hệ thống tự động resolve incident đang ở trạng thái `OPEN` hoặc `ACKNOWLEDGED`.
5. **Cancellation boundary**:
   - Khi incident được ACK: Hủy toàn bộ các notification delivery đang ở trạng thái `PENDING` (chuyển sang `CANCELED`), ngăn chặn gửi tiếp các bước escalation sau (Secondary / Team).
   - Khi incident được RESOLVE: Hủy toàn bộ delivery đang `PENDING`. Các delivery đã `SENT` giữ nguyên lịch sử kiểm toán.
6. **Flapping suppression**: Khi monitor đang trong thời gian flapping (`flapping_until > now()`), việc thay đổi trạng thái sang `DOWN` bị chặn không mở incident và không phát sinh notification.

### Public Status & Uptime Rules
1. **Public State Mapping**:
   - `HEALTHY` $\rightarrow$ `Operational`
   - `DEGRADED`, `PENDING_DOWN`, `PENDING_RECOVERY` $\rightarrow$ `Degraded`
   - `DOWN` $\rightarrow$ `Major outage`
   - `UNKNOWN` $\rightarrow$ `Unknown`
2. **Uptime & Coverage Calculation**:
   - Chỉ lấy mẫu từ các scheduled executions trong cửa sổ thời gian (24h, 7d, 30d).
   - Available: `QUORUM_PASS` và `SINGLE_REGION_FAILURE`.
   - Unavailable: `QUORUM_FAILURE`.
   - `INSUFFICIENT_RESULTS` (thiếu dữ liệu vùng): Bị loại khỏi mẫu số tính uptime, đồng thời làm giảm tỷ lệ `coveragePercentage`.
   - Công thức:
     $$\text{uptimePercentage} = \frac{\text{availableCount}}{\text{validCount}} \times 100$$
     $$\text{coveragePercentage} = \frac{\text{validCount}}{\text{totalCount}} \times 100$$
3. **Compatibility v0.1 / v0.2**:
   - Probe agent v0.2 tiếp nhận cả ProbeJob v0.1 (HTTP) và v0.2 (HTTP, TCP, SSL, Keyword).
   - Scheduler v0.2 phát hành ProbeJob v0.2.

---

## 2. Người 2 — Backend: Thiết kế API và migrations

### Migration 005_incident_response.sql
1. Mở rộng bảng `incidents`:
   - Cột `status`: `text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED'))`.
   - Cột `acknowledged_at timestamptz`, `acknowledged_by text`, `resolved_by text`.
   - Backfill dữ liệu có sẵn:
     ```sql
     UPDATE incidents SET status = CASE WHEN resolved_at IS NOT NULL THEN 'RESOLVED' ELSE 'OPEN' END;
     ```
   - Ràng buộc: `CREATE UNIQUE INDEX incidents_one_unresolved ON incidents(monitor_id) WHERE status != 'RESOLVED';`
2. Mở rộng `incident_events`:
   - `execution_id` cho phép `NULL` (khi ACK/resolve thủ công không gắn execution).
   - Thêm cột `actor text`.
   - Cập nhật check constraint: `CHECK (type IN ('OPENED', 'ACKNOWLEDGED', 'RESOLVED'))`.
3. Bảng `notification_channels`:
   - `type`: `SLACK` hoặc `EMAIL`.
   - Bảo mật: Slack channel chỉ lưu `{ "secretArn": "arn:aws:secretsmanager:..." }`, cấm lưu plaintext webhook URL. Email lưu `{ "recipient": "..." }`.
   - Composite FK / unique: `UNIQUE(id, organization_id)`.
4. Bảng `escalation_policies` & `escalation_policy_steps`:
   - Một organization có một chính sách mặc định gồm 3 bước:
     - Step 0 (Primary): delay 0 giây.
     - Step 1 (Secondary): delay 300 giây.
     - Step 2 (Team): delay 600 giây.
   - Ràng buộc: `UNIQUE(policy_id, step_order)`.
5. Bảng `notification_deliveries`:
   - Khóa duy nhất: `UNIQUE(incident_id, escalation_step_id)`.
   - Trạng thái: `PENDING`, `SENDING`, `SENT`, `FAILED`, `CANCELED`.
   - Retry logic: Tối đa 5 attempts; backoff sau 5s, 30s, 2m, 5m.
   - Claim lock: `next_attempt_at`, `locked_until`, `attempts`.

### Migration 006_status_pages.sql
1. Bảng `status_pages`:
   - Cột: `id`, `organization_id`, `name`, `slug` (globally unique, regex `^[a-z0-9-]+$`), `description`, `published`.
2. Bảng `status_page_components`:
   - Cột: `id`, `organization_id`, `status_page_id`, `monitor_id`, `public_name`, `display_order`.
   - Composite FKs `(status_page_id, organization_id)` và `(monitor_id, organization_id)` ngăn chặn tuyệt đối việc gắn monitor của tenant khác vào status page.

### Rollback Scripts
- `005_incident_response.sql`: Khôi phục bảng incidents, bỏ các cột mới, phục hồi index `incidents_one_open`, drop các bảng deliveries, escalation steps, escalation policies, notification channels.
- `006_status_pages.sql`: Drop bảng `status_page_components` và `status_pages`.
- Roundtrip test trong `scripts/migration-roundtrip.mjs` đã tích hợp đầy đủ chu trình rollback và reapply cả 006 và 005.

### OpenAPI Endpoints
- `POST /api/v1/incidents/{id}/ack` (Role: Responder+)
- `POST /api/v1/incidents/{id}/resolve` (Role: Responder+)
- `GET, POST /api/v1/notification-channels` (Admin+)
- `GET, PUT, DELETE /api/v1/notification-channels/{id}` (Admin+)
- `GET, PUT /api/v1/escalation-policy` (Admin+)
- `GET, POST /api/v1/status-pages` (Admin+)
- `GET, PUT, DELETE /api/v1/status-pages/{id}` (Admin+)
- `GET, POST /api/v1/status-pages/{id}/components` (Admin+)
- `DELETE /api/v1/status-pages/{id}/components/{componentId}` (Admin+)
- `GET /api/public/v1/status-pages/{slug}` (Không yêu cầu xác thực; Cache-Control: max-age=15)

---

## 3. Người 3 — Probe/Scheduler: Chốt schema 0.2

### Cấu hình loại check (MonitorConfig)
1. **HTTP (`kind: "http"`)**:
   - Kế thừa v0.1: `url`, `method` (GET/HEAD/POST/PUT/PATCH/DELETE), `timeoutMs` (100–30000), `expectedStatus` (100–599), `maxRedirects` (0–10), `maxResponseBytes` (1–1048576).
2. **TCP (`kind: "tcp"`)**:
   - `host`: hostname hoặc FQDN (không cho phép private IP ở production).
   - `port`: số nguyên từ 1 đến 65535.
   - `timeoutMs`: từ 100 đến 30000 ms.
3. **SSL (`kind: "ssl"`)**:
   - `host`: hostname mục tiêu.
   - `port`: cổng TLS (1–65535, mặc định 443).
   - `serverName`: SNI extension (tùy chọn, mặc định theo host).
   - `timeoutMs`: 100–30000 ms.
   - `warnBeforeDays`: cảnh báo hết hạn chứng chỉ (0–365 ngày).
4. **Keyword (`kind: "keyword"`)**:
   - `url`: endpoint HTTP/HTTPS.
   - `method`: `GET` hoặc `HEAD`.
   - `expectedStatus`: HTTP status code mong muốn.
   - `keyword`: chuỗi cần tìm (1–1000 ký tự).
   - `matchMode`: `CONTAINS` hoặc `NOT_CONTAINS`.
   - `caseSensitive`: boolean.
   - `maxRedirects`, `maxResponseBytes`, `timeoutMs`.

### Kết quả kiểm tra (ProbeResult)
- Bổ sung các object kết quả:
  - `tcp`: `{ "connected": boolean }`.
  - `ssl`: `{ "expiresAt": string (RFC 3339), "daysRemaining": integer }`.
  - `keyword`: `{ "statusCode": integer, "responseBytes": integer, "matched": boolean }`.
- Chuẩn hóa mã lỗi (`errorCode`):
  - TCP connect fail: `CONNECT` / `TIMEOUT`.
  - SSL hết hạn / hostname không khớp: `TLS` / `ASSERTION`.
  - Keyword không khớp: `ASSERTION`.
  - Private IP blocked: `SSRF_BLOCKED`.
  - DNS lookup fail: `DNS`.
  - Response vượt giới hạn: `RESPONSE_TOO_LARGE`.
  - Lỗi hệ thống probe: `INTERNAL`.
- Cơ chế SSRF Guarded Dialer (`network_guard.go`): Mọi kết nối dial TCP/TLS đều bắt buộc đi qua bộ lọc IP công khai; chặn toàn bộ loopback, link-local, private IP (RFC 1918) và cloud metadata IP (`169.254.169.254`).

---

## 4. Người 4 — Frontend: UI states và public response

### Incident Console
- Hiển thị rõ badge trạng thái: `OPEN`, `ACKNOWLEDGED`, `RESOLVED`.
- Hiển thị actor thực hiện và mốc thời gian: `openedAt`, `acknowledgedAt` (bởi ai), `resolvedAt` (bởi ai).
- Nút bấm hành động:
  - **Acknowledge**: Chỉ khả dụng khi trạng thái là `OPEN` và vai trò người dùng từ `RESPONDER` trở lên.
  - **Resolve**: Khả dụng khi trạng thái là `OPEN` hoặc `ACKNOWLEDGED`, vai trò từ `RESPONDER` trở lên.
  - Người dùng vai trò `VIEWER` chỉ xem, các nút hành động bị ẩn hoặc disable.
- Delivery timeline: Hiển thị các bước notification (Primary, Secondary, Team), kênh gửi (Slack/Email), trạng thái (`SENT`, `PENDING`, `CANCELED`, `FAILED`) và số lần thử (attempts). Không bao giờ hiển thị secret ARN hoặc webhook URL.

### Admin Configuration Console
- Kênh thông báo:
  - Slack: Input nhận AWS Secrets Manager ARN, có tooltip giải thích rõ cơ chế bảo mật (không nhận raw webhook).
  - Email: Input nhận địa chỉ email người nhận.
- Escalation policy editor:
  - Bảng các bước escalation với độ trễ (delay 0s, 300s, 600s).
  - Chỉ cho phép vai trò `OWNER` và `ADMIN` thêm, sửa, xóa.

### Public Status Page (`/api/public/v1/status-pages/{slug}`)
- Trạng thái tổng thể: Operational, Degraded, Major outage, Unknown.
- Danh sách component kèm uptime và độ bao phủ:
  - 24 giờ: `{ "percentage": number | null, "coverage": number }`
  - 7 ngày: `{ "percentage": number | null, "coverage": number }`
  - 30 ngày: `{ "percentage": number | null, "coverage": number }`
- Lịch sử incident công khai:
  - Trạng thái: Investigating, Identified, Monitoring, Resolved.
  - Timeline các lần cập nhật.
- **Ranh giới bảo mật (Zero Leakage)**:
  - Không chứa: URL monitor nội bộ, execution ID, probe ID, organization ID, stack trace, message lỗi kỹ thuật, latency chi tiết.

---

## 5. Người 5 — QA/SRE: Test harness, security và AWS gate

### Mock Notification Sinks
Thiết kế sink giả lập cục bộ cho Slack và Email với các kịch bản lỗi:
1. `200 OK`: Gửi thành công ngay lần đầu.
2. `429 Too Many Requests`: Kèm header `Retry-After: 5`, kiểm tra worker tạm hoãn và thử lại đúng thời điểm.
3. `500 / 503 Internal Error`: Kiểm tra quy tắc retry 5s, 30s, 2m, 5m; chuyển sang `FAILED` sau 5 lần thử.
4. `Timeout`: Giả lập không có phản hồi, kiểm tra worker release lock và không bị treo tiến trình.
5. Log redaction: Đảm bảo log worker không bao giờ in ARN bí mật hoặc payload nhạy cảm.

### E2E Clock Control
Hỗ trợ cơ chế mô phỏng thời gian (clock advancement) trong test harness để kiểm tra bước Secondary (300s) và Team (600s) mà không phải chờ 10 phút trong E2E tests.

### Rà soát Terraform cho Tuần 4
- Worker IAM policy: Bổ sung quyền `secretsmanager:GetSecretValue` cho các secret ARN bắt đầu bằng `arn:aws:secretsmanager:*:*:secret:argus/*`.
- SES IAM policy: Bổ sung quyền `ses:SendEmail` cho identity đã xác thực.
- Probe Security Group: Mở outbound TCP `1–65535` để hỗ trợ kiểm tra TCP cổng bất kỳ, tiếp tục không mở ingress.

### AWS Staging Gate Status
Trạng thái hiện tại: **BLOCKED**
- Lý do: Môi trường làm việc cục bộ chưa có AWS credentials, OIDC role, S3 remote state backend, HTTPS endpoint control plane, và Secrets Manager ARNs.
- Toàn bộ nghiệm thu Ngày 1 tập trung 100% vào contracts, codegen, migration designs và unit/integration tests trên môi trường local.

---

## 6. Checklist nghiệm thu Ngày 1

- [x] Baseline HTTP 3 region local được xác nhận và giữ vững.
- [x] Incident lifecycle `OPEN → ACKNOWLEDGED → RESOLVED`, idempotency và RBAC đã khóa hoàn toàn.
- [x] Ranh giới hủy delivery (cancellation boundary) khi ACK/resolve đã được xác định rõ ràng.
- [x] Migrations `005_incident_response.sql` và `006_status_pages.sql` đã tạo kèm backfill, constraints và rollback scripts.
- [x] Script `scripts/migration-roundtrip.mjs` đã cập nhật và kiểm thử roundtrip rollback/reapply 006 và 005 thành công.
- [x] Ràng buộc bảo mật cơ sở dữ liệu: Chỉ lưu Secrets Manager ARN, tuyệt đối không lưu plaintext webhook.
- [x] Public status page response contract được kiểm duyệt không chứa bất kỳ dữ liệu nội bộ nào.
- [x] Probe schema v0.2 hỗ trợ HTTP, TCP, SSL, Keyword và duy trì tính tương thích ngược với v0.1.
- [x] Fixtures producer/consumer dùng chung (`week4-day1-fixtures.json`, các probe job/result TCP, SSL, Keyword) đã tạo và validate khớp schema.
- [x] Script `pnpm contracts:generate` và `pnpm contracts:check` chạy thành công 100%.
- [x] Toàn bộ monorepo pass `pnpm typecheck`, `@argus/domain` pass 61/61 tests và build thành công.
- [x] Trạng thái AWS Gate được xác nhận rõ ràng là `BLOCKED` kèm lý do kỹ thuật.

---

## 7. Bàn giao cho Ngày 2

| Người | Trách nhiệm bắt đầu Ngày 2 | Phụ thuộc đầu vào từ Ngày 1 |
|---|---|---|
| **Người 1 — Tech Lead** | Giám sát invariants, review code migration và PR state machine. | Contracts và invariants đã khóa tại Section 1. |
| **Người 2 — Backend** | Triển khai migration runner, API `/ack` & `/resolve`, RBAC guard, và domain event emitter. | Migration 005/006 và OpenAPI spec tại Section 2. |
| **Người 3 — Probe** | Triển khai Go executors cho TCP, SSL, Keyword và viết unit tests trong `agents/probe`. | Schema 0.2 và models Go đã sinh tại Section 3. |
| **Người 4 — Frontend** | Dựng giao diện chi tiết incident với nút ACK/Resolve, timeline delivery và form config. | UI state table và OpenAPI types đã sinh tại Section 4. |
| **Người 5 — QA/SRE** | Viết concurrency tests cho ACK/Resolve và dựng mock notification sink server. | Fault matrix và fixtures tại Section 5. |
