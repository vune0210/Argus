# Tuần 3 / ngày 4 — Staging gate và rehearsal demo

## Quyết định go/no-go

Staging AWS đang **BLOCKED**. Không có AWS account/role, remote-state backend, HTTPS control-plane URL, ba Secrets Manager ARN, GitHub repository/OIDC environment hoặc release artifact `verified-regional-release` trong workspace hay môi trường chạy hiện tại. Không thực hiện `terraform apply`, registry push, ECS rollout hoặc migration trên staging khi thiếu các đầu vào này.

| Dependency | Owner | Điều kiện đóng |
| --- | --- | --- |
| Remote-state backend và role Terraform | QA/SRE | Bootstrap plan đã review qua workflow được phê duyệt. |
| HTTPS control-plane staging | Backend | Probe gọi được HTTPS/443 và health endpoint hợp lệ. |
| Secret ARN và HMAC registration của ba probe | Backend + QA/SRE | Mỗi region có probe identity ACTIVE; token không xuất hiện trong log. |
| GitHub repository, OIDC role, protected staging environment | QA/SRE | Workflow release tạo `verified-regional-release`. |
| Artifact ECR ba region | Probe + QA/SRE | Một revision và manifest digest giống nhau ở Singapore, Tokyo, Frankfurt. |

## Runbook rollout khi gate mở

1. Dùng `backend.hcl` và `staging.tfvars` không commit. Chạy bootstrap plan với `image_digest=""` và `desired_count=0`; review trước khi apply qua workflow hạ tầng.
2. Áp dụng migration 004, khởi động worker maintenance và chạy backfill tới `inserted: 0`. Xác nhận canonical receipt/result không đổi.
3. Đăng ký ba probe bằng secret reference qua `probe:register`; chỉ bàn giao ID, region và ARN.
4. Dispatch **Prepare regional probe release** trên revision đã duyệt. Chỉ dùng `probe-release.auto.tfvars.json` từ artifact `verified-regional-release` để plan ECS với `desired_count=1`.
5. Rollout lần lượt Singapore, Tokyo, Frankfurt. Với mỗi region, lưu task ARN, image digest, log location, heartbeat và kết quả gọi HTTPS control plane.
6. Tạo một HTTP monitor staging được phép. Lưu execution ID, ba receipt/raw row, SSE events, screenshot desktop/mobile và task ARN trong cùng evidence record.

Rollback ứng dụng dùng previous verified digest. Nếu chưa có revision tốt, set `desired_count=0` và giữ VPC, ECR, logs, secret để điều tra. Rollback migration theo `docs/week-3-day-2.md`, độc lập với rollback probe.

## Rehearsal demo local

Demo dùng một HTTP monitor với ba region `ap-southeast-1`, `ap-northeast-1`, `eu-central-1` và test target `http://host.docker.internal:8080/check`.

Rehearsal đã chạy thành công với execution `cdcbede6-c1e9-412a-989c-4bd3015cdebe`: ba Go probe gửi scheduled result, có đúng một raw copy mỗi region, SSE phát completion event, và snapshot/SSE cross-tenant bị từ chối. Drill recovery cũng pass: kill probe khi đang thực thi, probe khác reclaim lease, owner cũ nhận HTTP 410 và chỉ một raw result được lưu.

1. Tạo monitor và chờ một scheduled execution hoàn tất; dashboard phải hiển thị ba result PASS, heartbeat ALIVE và SSE connected.
2. Chứng minh duplicate/tenant isolation bằng smoke output: một raw result mỗi region, snapshot/SSE của tenant khác bị từ chối.
3. Kill một probe khi đang có lease; probe thay thế phải reclaim, old owner nhận 410 và chỉ một raw result được lưu.
4. Ghi lại execution ID, output smoke/recovery, image digest local và screenshot dashboard. Kết quả local không được mô tả là staging AWS.

## Backlog ngày 5

| Item | Owner | Mức độ |
| --- | --- | --- |
| Cấp dependency staging trong bảng gate | QA/SRE và Backend | Release blocker |
| Thay thuộc tính Terraform `aws_region.current.name` đã deprecated bằng thuộc tính được AWS provider hỗ trợ | QA/SRE | Trước khi nâng provider |
| Chạy browser evidence trên URL staging thật sau ECS rollout | Frontend | Release blocker |
| Lưu dashboard/alert runtime cho scheduler lag, Redis pending, outbox failures và heartbeat region | QA/SRE | Release blocker |
