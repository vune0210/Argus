# Nghiệm thu Tuần 4: Báo cáo Trạng thái Kỹ thuật & Bằng chứng Thực thi

## 1. Trạng thái Đạt được (Final Gate Status)

> [!IMPORTANT]
> **Trạng thái cuối cùng công bố:** **`Local/runtime accepted — AWS staging blocked`**
> - **Cổng 1 (Local/runtime ready):** **ĐẠT (ACCEPTED)** — Toàn bộ chuỗi runtime Tuần 4 đã được chứng minh chạy thật trên Docker Compose (API, Web, Worker, PostgreSQL 16, Redis 7, Test Target, Mock Notification Sink, 3 Go Probe Agents).
> - **Cổng 2 (AWS staging rollout):** **BỊ CHẶN (BLOCKED)** — Dừng đúng theo quy tắc do workspace chưa có AWS role/OIDC, Route53 Hosted Zone, 2 ACM TLS Certificates, Slack Secret ARN, SES identity, và probe secrets.
> - **Lưu ý Review:** Workspace hiện tại không có Git repository (`git init` / `git commit` không được tự ý thực hiện theo cam kết), do đó Gemini **không tự tuyên bố review đã hoàn tất** mà cung cấp toàn bộ bằng chứng cho người dùng nghiệm thu độc lập.

---

## 2. Tổng hợp Kết quả Thực thi Cổng 1 (Local / Runtime Acceptance)

### A. Nghiệm thu E2E 5 chu kỳ liên tiếp trên Runtime thật (`pnpm test:week4-demo`)
Chạy trực tiếp qua HTTP API, Background Worker, Test Target và 3 Go Probe containers thật (`ap-southeast-1`, `ap-northeast-1`, `eu-central-1`). **Không sử dụng bất kỳ mock/synthetic test hay đối tượng `SENT` giả lập trong bộ nhớ. Toàn bộ độ trễ SLA được đo bằng timestamp thực tế.**

| Chu kỳ (Cycle) | Dashboard SSE Lag (SLA < 5s) | Primary Notification (SLA < 10s) | Incident Open Lag (SLA < 15s) | Recovery Delivery Lag | Trạng thái ACK & Auto-resolve |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Cycle 1** | **1,001 ms** | **1,719 ms** | **582 ms** | **1,481 ms** | Primary: SENT, Secondary/Team: CANCELED, Recovery: 2 SENT |
| **Cycle 2** | **1,143 ms** | **1,414 ms** | **517 ms** | **1,699 ms** | Primary: SENT, Secondary/Team: CANCELED, Recovery: 2 SENT |
| **Cycle 3** | **976 ms** | **1,262 ms** | **760 ms** | **1,204 ms** | Primary: SENT, Secondary/Team: CANCELED, Recovery: 2 SENT |
| **Cycle 4** | **1,108 ms** | **1,142 ms** | **279 ms** | **1,247 ms** | Primary: SENT, Secondary/Team: CANCELED, Recovery: 2 SENT |
| **Cycle 5** | **1,135 ms** | **1,606 ms** | **516 ms** | **1,657 ms** | Primary: SENT, Secondary/Team: CANCELED, Recovery: 2 SENT |
| **Đánh giá SLA** | **ĐẠT (Tối đa 1.14s)** | **ĐẠT (Tối đa 1.72s)** | **ĐẠT (Tối đa 0.76s)** | **ĐẠT (Tối đa 1.70s)** | **100% 5/5 chu kỳ đạt chuẩn** |

---

### B. Điều phối Kiểm thử Tuần 4 (`pnpm test:week4`)
Bộ điều phối [scripts/test-week4.mjs](file:///d:/app/123/project8/scripts/test-week4.mjs) đã thay thế hoàn toàn mã kiểm tra chuỗi tĩnh cũ, chạy 5 bộ tích hợp thực:
1. **Migration 008 Roundtrip & Rollback/Reapply (`scripts/migration-roundtrip.mjs`)**:
   - Chạy trên PostgreSQL thật: Tạo bảng `escalation_step_channels`, backfill kênh cũ, tạo partial unique indexes dedup cho `INCIDENT_OPENED` và `INCIDENT_RESOLVED`.
   - Rollback và reapply an toàn, bảo toàn canonical data.
2. **Notification Service & Multi-Channel Escalation (`scripts/week4-notifications.mjs`)**:
   - 10 kịch bản: Gửi đồng thời Slack + Email khi mở sự cố, hủy Secondary/Team khi ACK, tạo đúng 1 Slack + 1 Email recovery khi resolve, bảo đảm không lặp lại khi replay, exponential backoff với jitter.
3. **Status Page Public API & Privacy Boundary (`scripts/week4-status.mjs`)**:
   - 12 kịch bản: Kiểm tra hierarchy component, cập nhật thời gian thực, ẩn hoàn toàn ID nội bộ, monitor ID, target URL, probe ID.
4. **Multi-Protocol Check Types Integration (`scripts/week4-check-types.mjs`)**:
   - 7 kịch bản: Xác thực tạo monitor và probe lease/result cho HTTP, TCP, SSL, Keyword; kiểm tra Go probe validator và executor contracts.
5. **Terraform Invariants Mock Tests (`scripts/check-terraform-invariants.test.mjs`)**:
   - 8 kịch bản kiểm tra: Health check route `/api/health`, mã hóa KMS, private networking tái sử dụng subnet, SG egress 5432/6379, digest bất biến & gate desired-count = 0, IAM scoped tasks role không wildcard, CloudFront status-origin secret header & tách biệt chứng chỉ.

---

### C. Toàn bộ Bộ Xác thực Hệ thống (`pnpm verify`)
- **Tỷ lệ bài kiểm tra bị bỏ qua (Skipped tests):** **`0 SKIPPED`**
- **Domain logic (`@argus/domain`):** 67/67 tests passed.
- **Web Frontend (`apps/web`):** 29/29 tests passed (bao gồm test `/api/health` trả 200).
- **API Control Plane (`apps/api`):** 133/133 tests passed (13 suites, bao gồm pipeline integration, scheduler load gate 1000-monitor, raw-history rollback/backfill, monitors, notifications, status-pages).
- **Target test & Regional release:** 3/3 tests passed.
- **Build:** TypeScript compilation (`contracts`, `domain`, `api`) và Next.js 15 production build hoàn tất thành công.

---

### D. Chaos Drill & Phục hồi (`pnpm test:chaos`)
- Kịch bản 1: Mất kết nối vùng (missing region) trả về `INSUFFICIENT_RESULTS` mà không mở sự cố giả.
- Kịch bản 2: Hai lần lỗi mở 1 sự cố; `Run now` chỉ đóng vai trò diagnostic giữ nguyên trạng thái sức khỏe; hai lần pass tự động auto-resolve.
- Kịch bản 3: Khởi động lại Redis (draining durable work) không làm thất thoát kết quả hoặc sinh bản ghi trùng lặp; nhận đủ 4 sự kiện SSE.

---

## 3. Hoàn thiện Terraform Control Plane & Source Code

1. **Web Health Check:**
   - Thêm route [apps/web/app/api/health/route.ts](file:///d:/app/123/project8/apps/web/app/api/health/route.ts) trả về `200 OK` với body `{"status":"healthy","service":"argus-web"}`.
2. **Loại bỏ Database Password khỏi Terraform State:**
   - Hỗ trợ `DATABASE_SECRET_ARN` đọc bí mật từ RDS-managed AWS Secrets Manager lúc khởi động; vẫn ưu tiên `DATABASE_URL` cho local/Docker Compose/test.
3. **Redis Transit & Networking:**
   - Cấu hình `rediss://<endpoint>:6379` cho staging. Đặt Redis trong các data subnet hiện có mà không tạo subnet group execution trùng lặp.
4. **Security Group Egress:**
   - Giới hạn cụ thể egress từ API/Worker tới PostgreSQL port 5432 và Redis port 6379.
5. **Worker Image Digest & Desired Count Gate:**
   - Khóa biến `worker_image_digest`; chặn kích hoạt ECS Service nếu digest của API, Web hoặc Worker còn rỗng.
6. **Worker IAM Task Role:**
   - Xóa bỏ wildcard `*`; chỉ cấp `secretsmanager:GetSecretValue` trên danh sách ARN bí mật (Slack, DB, HMAC) và `ses:SendEmail` trên SES identity.
7. **Tách biệt Chứng chỉ & CloudFront Origin Routing:**
   - `alb_certificate_arn` thuộc Singapore (`ap-southeast-1`), `cloudfront_certificate_arn` thuộc `us-east-1`.
   - Tạo endpoint `status-origin.<domain>` trỏ ALB để CloudFront kết nối HTTPS hợp lệ; định tuyến qua custom secret header `X-Argus-Origin-Secret`.
8. **CloudWatch Alarms:**
   - Đã gán đúng ARN của ALB, RDS và ECS; cấu hình gửi cảnh báo tới SNS topic staging `aws_sns_topic.alerts.arn`.

---

## 4. Điều kiện Tiên quyết để Mở khóa Cổng 2 (AWS Staging Rollout)

Theo kế hoạch, Gemini **dừng trước bước triển khai AWS**. Để kích hoạt Giai đoạn 2, cần các tài nguyên AWS thực tế sau:
1. **AWS Credentials / GitHub OIDC Role:** Quyền thực thi Terraform và đẩy Docker image lên ECR.
2. **Route53 & Domain:** Staging hosted zone và domain tên miền.
3. **2 Chứng chỉ ACM TLS:** 1 chứng chỉ tại `ap-southeast-1` (cho ALB) và 1 chứng chỉ tại `us-east-1` (cho CloudFront).
4. **Secrets Manager & SES:** Staging Slack Webhook Secret ARN, Probe tokens Secret ARN, HMAC key ARN, và SES verified sender domain.
5. **Ủy quyền chính thức:** Người dùng cấp lệnh chấp thuận apply hạ tầng AWS.
