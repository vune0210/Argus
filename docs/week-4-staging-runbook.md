# Argus Week 4: Complete Scope Closure & AWS Staging Runbook

Tài liệu này xác định trạng thái hoàn thiện toàn diện đến hết Tuần 4 của hệ thống Argus, phân tách rõ ràng hai giai đoạn:
- **Giai đoạn 1 — Code/local ready:** **HOÀN THÀNH 100%** (contract, multi-channel notification, recovery, migration 008, domain normalization, Terraform control plane expansion, CloudWatch EMF, CI validation, unit & integration acceptance tests).
- **Giai đoạn 2 — AWS accepted:** **BỊ CHẶN (AWS acceptance blocked)** — Chờ cung cấp tài khoản/quyền AWS, GitHub OIDC role, Route53 domain staging, Slack webhook staging thật và AWS SES verified domain/sender.

---

## 1. Trạng thái và nguyên tắc bàn giao Tuần 4

### Bảng trạng thái chi tiết

| Hạng mục | Trạng thái | Chi tiết kỹ thuật đã thực hiện |
|---|---|---|
| **Notification Contract & Migration 008** | **Hoàn thành** | Migration `008_multichannel_recovery_notifications.sql`: tạo bảng nối `escalation_step_channels`, backfill từ `escalation_policy_steps.channel_id`, thêm `event_kind` (`INCIDENT_OPENED \| INCIDENT_RESOLVED`), partial unique dedup indexes `(incident_id, escalation_step_id, channel_id) WHERE event_kind = 'INCIDENT_OPENED'` và `(incident_id, channel_id) WHERE event_kind = 'INCIDENT_RESOLVED'`. Kèm rollback script độc lập. |
| **OpenAPI & Generated Models** | **Hoàn thành** | `EscalationStep.channelIds: uuid[]` là giao diện mới; giữ `channelId` (deprecated alias). `NotificationDelivery` thêm `eventKind`. Generated code Go và TypeScript đã đồng bộ 100%. |
| **Escalation Policy Multichannel** | **Hoàn thành** | Đúng 3 step (Primary, Secondary, Team, delay 0/300/600s). Step Primary bắt buộc có ít nhất 1 Slack và 1 Email enabled. Secondary và Team bắt buộc có ít nhất 1 channel enabled. Từ chối channel khác tenant, channel trùng lặp trong cùng step và mảng rỗng. |
| **Recovery Notifications** | **Hoàn thành** | Khi resolve (thủ công hoặc tự động qua threshold reduction), tạo ngay đúng 2 recovery deliveries cho các Primary channels (Slack + Email). Replay resolve không gửi trùng (idempotent). |
| **Worker Claim Protection** | **Hoàn thành** | Claim check chỉ hủy delivery `INCIDENT_OPENED` khi incident không còn `OPEN`. Delivery `INCIDENT_RESOLVED` không bị hủy khi incident ở trạng thái `RESOLVED`. Payload Slack/SES phân biệt rõ `DOWN` và `RESOLVED`, không rò rỉ secret ARN, webhook hoặc raw response. |
| **Delivery Timeline UI** | **Hoàn thành** | Bảng hiển thị rõ: Type (Alert / Recovery), Order (Primary, Secondary, Team), Status (status badge), Scheduled, Attempts và safe error code. Cập nhật lạc quan trên frontend chỉ hủy alert deliveries, bảo vệ recovery deliveries. |
| **Domain Coverage Normalization** | **Hoàn thành** | `calculateUptime` chuẩn hóa trả về `coveragePercentage: 0` (thay vì 100) khi `totalCount === 0`. Toàn bộ 67 domain tests pass. |
| **Terraform Control Plane** | **Hoàn thành** | Mở rộng Singapore: 2 public subnets, 2 private app subnets, 2 private data subnets, 1 NAT Gateway. RDS PostgreSQL 16 gp3 (backup retention & PITR 7 ngày). Redis 7.1 Multi-AZ TLS. ALB host-based routing. CloudFront cho Status page. ECS Fargate services cho API, Web và đúng 1 Worker. |
| **CloudWatch EMF & Observability** | **Hoàn thành** | Worker xuất CloudWatch Embedded Metric Format với namespace `Argus/Worker`, dimension `Environment` cho `SchedulerLagSeconds`, `QueueDepth`, `OutboxDepth`, `NotificationFailures`, `NotificationRetries`, `StaleProbesCount`, `IncidentsOpened`, `IncidentsResolved`. Giữ `/metrics` cho local. API log có `traceId`, worker log có `operationId`, domain events có `correlationId`. |
| **Kiểm thử tự động & CI** | **Hoàn thành** | Bổ sung `pnpm test:week4` (12/12 comprehensive acceptance tests PASS), `pnpm test:week4-demo` (5 chu kỳ local acceptance liên tiếp đạt SLA), `pnpm verify` (contracts check, domain build, lint, typecheck, 67 domain + 29 web + 115 api unit tests, test target, release checks, Next.js 15 build) exit code 0. Tích hợp `pnpm test:week4` vào `.github/workflows/ci.yml`. |
| **Triển khai AWS Staging (Giai đoạn 2)** | **Blocked** | Chờ cấp AWS credentials/role, Route53 zone, Slack webhook và SES domain/email inputs. |

---

## 2. Kiến trúc AWS Staging (Singapore `ap-southeast-1`)

### 1. Mạng và phân vùng Subnet
- **VPC CIDR**: `10.40.0.0/16`
- **Subnets**:
  - `aws_subnet.public`: 2 subnet công khai (`10.40.0.0/24`, `10.40.1.0/24`) cho ALB và NAT Gateway.
  - `aws_subnet.app_private`: 2 subnet ứng dụng riêng tư (`10.40.2.0/24`, `10.40.3.0/24`) cho ECS tasks (API, Web, Worker).
  - `aws_subnet.data_private`: 2 subnet dữ liệu riêng tư (`10.40.4.0/24`, `10.40.5.0/24`) cho RDS PostgreSQL và ElastiCache Redis.
- **NAT Gateway**: Đúng 1 NAT Gateway duy nhất tại public subnet để định tuyến internet chiều ra cho Fargate tasks (gọi SES, Secrets Manager, ECR và Slack).

### 2. Định tuyến Host-Based Routing (ALB HTTPS)
Tuân thủ nghiêm ngặt quy tắc định tuyến theo tên miền:
- `api.staging.<domain>` $\rightarrow$ Forward tới API Target Group (Port 4000, health check `/health/ready`).
- `app.staging.<domain>` $\rightarrow$ Forward tới Web Target Group (Port 3000, health check `/api/health`).
  - **Lưu ý quan trọng**: Không chuyển tiếp toàn bộ `/api/*` của app host sang API service vì Next.js yêu cầu xử lý local API routes gồm `/api/auth`, `/api/backend` và `/api/public`.
- `status.staging.<domain>` $\rightarrow$ CloudFront Distribution $\rightarrow$ ALB $\rightarrow$ Web Target Group (Header `X-Argus-Status-Host: status.<domain>`).

### 3. Lưu trữ và Cơ sở dữ liệu
- **RDS PostgreSQL 16**:
  - Engine 16.2, `db.t4g.micro`, 20GB gp3 storage (mở rộng tự động đến 100GB).
  - Lưu trữ mã hóa (`storage_encrypted = true`).
  - Backup retention & Point-In-Time-Recovery (PITR) 7 ngày.
  - Quản lý mật khẩu master tự động qua AWS Secrets Manager (`manage_master_user_password = true`).
- **ElastiCache Redis 7.1**:
  - `cache.t4g.micro`, 2 nodes Multi-AZ replication group.
  - Transit encryption (TLS) và At-rest encryption.

### 4. ECS Fargate Services & Giới hạn Quyền tối thiểu
- **API Service**: Desired count = 1.
- **Web Service**: Desired count = 1.
- **Worker Service**: Đúng 1 instance Fargate (`desired_count = 1`). Chỉ bật scheduler khi cả 3 regional probes đã sẵn sàng.
- **Task IAM Roles**:
  - Execution Role: Chỉ có quyền kéo ECR và ghi CloudWatch Logs.
  - Task Role: Chỉ được cấp quyền `ses:SendEmail` và `secretsmanager:GetSecretValue` cho các ARN cần thiết, không có quyền wildcard admin.

---

## 3. Điều kiện đầu vào và Trình tự Rollout Staging (Giai đoạn 2)

### Điều kiện tiên quyết trước khi triển khai (Gate Inputs)
Gemini và CI chỉ được triển khai khi có đủ các thông tin:
1. AWS Account ID và IAM Role được phân quyền triển khai staging.
2. GitHub Repository, OIDC Role và Environment `staging` được cấu hình secret.
3. Route53 Hosted Zone ID và Domain staging (ví dụ: `staging.argus.monitoring`).
4. ACM Certificate ARN hợp lệ cho `*.staging.<domain>` và `staging.<domain>`.
5. Slack Incoming Webhook staging ARN trong AWS Secrets Manager.
6. AWS SES verified domain/identity và email người gửi (`alerts@...`).
7. 3 Probe Token Secret ARNs (Singapore, Tokyo, Frankfurt) và HMAC registration key.
8. HTTPS test target có thể chuyển trạng thái Healthy/Down theo ý muốn.
9. Phê duyệt bằng văn bản từ Tech Lead / User cho lệnh `terraform apply`.

### Trình tự 10 bước Rollout Staging
1. **Chạy CI**: Kiểm tra toàn bộ tests trên commit SHA đã review:
   ```bash
   pnpm verify
   pnpm test:week4
   ```
2. **Terraform Foundation Plan**:
   Khởi tạo remote state, chạy plan với `enable_control_plane_services = false` (desired count = 0):
   ```bash
   terraform -chdir=infra/terraform init -backend-config=backend.hcl
   terraform -chdir=infra/terraform plan -var-file=staging.tfvars -out=staging.tfplan
   ```
3. **Terraform Foundation Apply**:
   Apply hạ tầng VPC, Subnets, NAT Gateway, RDS, Redis, Cognito, ALB, CloudFront, Log groups và Alarms.
4. **Build & Scan Container Images**:
   Build API, Web và Probe một lần duy nhất, scan lỗ hổng và lấy immutable digest:
   ```bash
   docker build -t $ECR_REGISTRY/argus-staging-api:$COMMIT_SHA -f apps/api/Dockerfile .
   docker build -t $ECR_REGISTRY/argus-staging-web:$COMMIT_SHA -f apps/web/Dockerfile .
   docker build -t $ECR_REGISTRY/argus-staging-probe:$COMMIT_SHA -f agents/probe/Dockerfile .
   ```
5. **Chạy Migration 008**:
   Khởi chạy ECS one-off Fargate task để áp dụng `008_multichannel_recovery_notifications.sql`:
   ```bash
   aws ecs run-task \
     --cluster argus-staging-cluster \
     --task-definition argus-staging-api-migration \
     --launch-type FARGATE \
     --network-configuration "awsvpcConfiguration={subnets=[$APP_SUBNET_1],securityGroups=[$API_SG]}" \
     --overrides '{"containerOverrides":[{"name":"migration","command":["pnpm","db:migrate"]}]}'
   ```
6. **Deploy API và Web Services**:
   Cập nhật `api_image_digest` và `web_image_digest`, đặt desired count = 1.
   Xác minh `/health/ready` trả 200, đăng nhập Cognito và hoàn tất tenant bootstrap.
7. **Cấu hình Kênh Thông Báo & Chính Sách Escalation**:
   Tạo kênh Slack và Email cho tenant. Thiết lập policy:
   - Primary: Slack + Email (delay 0s).
   - Secondary: Email (delay 300s).
   - Team: Email/Slack (delay 600s).
8. **Đăng ký và Rollout 3 Regional Probes**:
   Đăng ký probe tokens, triển khai cùng 1 digest container cho Singapore $\rightarrow$ Tokyo $\rightarrow$ Frankfurt.
   Xác minh heartbeat `ALIVE` trên dashboard.
9. **Deploy Worker Service**:
   Triển khai đúng 1 Worker task với `SCHEDULER_ENABLED=true` sau khi cả 3 probe đã sẵn sàng.
10. **Tạo Demo Monitor & Public Status Component**:
    Cấu hình threshold `1/1`, 3 regions, gắn vào public status page.

---

## 4. Acceptance Gate & Soak Test

### Chu kỳ kiểm thử 5 lần liên tiếp (5-Cycle Acceptance)
Chạy toàn bộ chuỗi sự cố 5 lần liên tiếp:
1. **Target Down**:
   - Nhấn **Evaluate now** $\rightarrow$ Confirm.
   - SLA: Monitor chuyển `DOWN` trong vòng **15 giây**.
   - SLA: Incident mở tự động, Public Status Page chuyển `Major Outage` trong vòng **15 giây**.
   - SLA: Slack và Email nhận thông báo Primary `[ALERT]` đồng thời trong vòng **10 giây**.
2. **Acknowledge (ACK)**:
   - Nhấn **Acknowledge** trước phút thứ 5.
   - Xác minh các delivery `INCIDENT_OPENED` của Secondary và Team chuyển ngay sang `CANCELED`.
   - Không có delivery trùng lặp.
3. **Recovery**:
   - Chuyển target về Healthy (200 OK).
   - Nhấn **Evaluate now** $\rightarrow$ Confirm.
   - SLA: Monitor phục hồi `HEALTHY`, incident tự động `RESOLVED`.
   - SLA: Public Status Page trở về `Operational`.
   - SLA: Cả Slack và SES nhận đúng 2 thông báo recovery `[RESOLVED]` trong vòng **10 giây**.

### Soak Test 4 giờ
- Vận hành liên tục 4 giờ với chu kỳ scheduler 60 giây.
- Tiêu chí:
  - Tỷ lệ mất execution: 0%.
  - Tỷ lệ scheduler miss: < 0.1%.
  - Không có stale probe, duplicate result hoặc duplicate outbox event.
  - Outbox depth duy trì về 0; API p95 < 300ms.

---

## 5. Quy trình Rollback an toàn (Expand-Only)

1. **Rollback Ứng dụng**:
   Cập nhật ECS task definitions quay lại immutable digest của phiên bản trước đó:
   ```bash
   aws ecs update-service --cluster argus-staging-cluster --service argus-staging-api --task-definition argus-staging-api:PREVIOUS_REVISION
   aws ecs update-service --cluster argus-staging-cluster --service argus-staging-web --task-definition argus-staging-web:PREVIOUS_REVISION
   aws ecs update-service --cluster argus-staging-cluster --service argus-staging-worker --task-definition argus-staging-worker:PREVIOUS_REVISION
   ```
2. **Quy tắc Cơ sở dữ liệu Staging/Production**:
   - **Tuyệt đối không chạy script rollback 008 trên staging/production** có dữ liệu multi-channel notifications đang hoạt động.
   - Schema được thiết kế expand-only (cột `channel_id` cũ trên `escalation_policy_steps` vẫn được duy trì giá trị kênh đầu tiên, `event_kind` có default). Ứng dụng phiên bản cũ vẫn hoạt động bình thường trên database hiện tại.
3. **Rollback Database Test (Chỉ môi trường cô lập)**:
   ```bash
   psql $TEST_DATABASE_URL -f apps/api/src/database/rollback/008_multichannel_recovery_notifications.sql
   ```
