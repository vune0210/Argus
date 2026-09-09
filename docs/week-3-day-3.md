# Tuần 3 / ngày 3 — Integration ba region

## Kết quả nghiệm thu local

Ngày 3 đã xác nhận toàn bộ luồng HTTP theo ba region trên môi trường local cô lập:

- Scheduler tạo một execution cho `ap-southeast-1`, `ap-northeast-1` và `eu-central-1`.
- Ba probe Go dùng cùng image `argus-probe:week3-day2` hoàn tất checks và dashboard contract nhận snapshot/SSE theo từng region.
- Execution `2e732b5a-48bd-499f-9fb1-f95786bbf3a9` đã có đúng ba raw result, một SSE result event cho mỗi region và completion event.
- Cross-tenant snapshot/SSE bị từ chối; lease probe không xác thực bị từ chối.
- Drill recovery đã kill probe đang thực thi, probe khác reclaim lease, owner cũ nhận HTTP 410 và chỉ một raw result được lưu.

Artifact local được kiểm tra là `linux/amd64`, chạy với user `nonroot:nonroot`, và image config không có biến môi trường token, secret hoặc HMAC key. Digest local là `sha256:51861c28593fe0a83a1bc2a8e20eef698a1a8249ccdb7ca0ed2611acae095922`; đây không phải bằng chứng artifact đã được push vào ECR.

## Kiểm tra đã chạy

| Kiểm tra | Kết quả |
| --- | --- |
| Migration staging-equivalent trên PostgreSQL local | PASS; migration đã ở trạng thái mới nhất. |
| `pnpm verify` với PostgreSQL/Redis cô lập | PASS: 51 domain tests, 38 API tests, 20 web tests, 2 target tests và 1 release test; contracts, lint, typecheck và production build đều đạt. |
| API pipeline integration | PASS: 13 tests, gồm duplicate, late result, raw-write rollback, fencing và reclaim. |
| Load gate | PASS: 1.000 execution, 3.000 target, p95 scheduler lag 2,085 giây. |
| `pnpm test:release` | PASS. |
| `pnpm test:target` | PASS: 2 tests. |
| `pnpm test:week3-smoke` | PASS: ba probe Go, raw partition, snapshot, SSE và tenant isolation. |
| `pnpm test:probe-recovery` | PASS: kill/reclaim/old owner fenced/one raw result. |
| Terraform `fmt -check`, `validate`, mock `test` | PASS; hai test cho ba provider-region. |

Terraform báo cảnh báo deprecation cho `data.aws_region.current.name`; nó không làm validate hoặc mock tests thất bại. Cần đổi sang thuộc tính thay thế được AWS provider khuyến nghị trước khi nâng provider tiếp theo.

API integration suites hiện chạy tuần tự qua `vitest run --no-file-parallelism`. PostgreSQL và Redis là state dùng chung trong các suite này; chạy song song có thể tạo deadlock cleanup hoặc để một suite lấy lease của suite khác.

## Trạng thái staging AWS

Mục tiêu staging AWS **blocked**, chưa được đánh dấu đạt. Không có AWS CLI hoặc Terraform CLI trên máy, không có biến môi trường AWS/Terraform/staging, và workspace cũng không có Git metadata để dispatch workflow phát hành.

| Dependency | Owner | Hạn để tiếp tục |
| --- | --- | --- |
| AWS account, remote-state backend và role áp dụng Terraform | QA/SRE | Trước phiên integration tiếp theo |
| HTTPS control-plane URL staging | Backend | Trước bootstrap plan |
| Ba Secrets Manager ARN và đăng ký HMAC của probe | Backend + SRE | Trước ECS rollout |
| GitHub repository, OIDC role và protected `staging` environment | SRE | Trước dispatch workflow |
| Release artifact `verified-regional-release` | Probe/SRE | Sau khi workflow publish thành công |

## Handoff deployment staging

1. Tạo file `backend.hcl` và `staging.tfvars` không được commit, dựa trên các file example trong `infra/terraform/probes`; điền HTTPS control-plane URL và ba secret ARN thật.
2. Apply bootstrap với `image_digest=""` và `desired_count=0` qua workflow hạ tầng được phê duyệt. Xác nhận ECR, logs, network, execution role và secret access tại cả ba region.
3. Dispatch workflow **Prepare regional probe release** ở source revision đã được duyệt. Chỉ dùng artifact `verified-regional-release`; nó phải chứng minh một digest chung ở ba registry.
4. Dùng `probe-release.auto.tfvars.json` tải từ workflow để plan/apply ECS với `desired_count=1`. Kiểm tra task ARN, digest, CloudWatch log, heartbeat và HTTPS control-plane cho từng region.
5. Tạo monitor HTTP được phép trên staging, lưu execution ID, snapshot/SSE evidence, raw-result count và screenshot dashboard cùng với task ARN/digest.

Rollback ứng dụng dùng digest đã xác minh trước đó. Nếu chưa có revision tốt, plan `desired_count=0`; giữ nguyên VPC, ECR, logs và secret. Rollback migration là quy trình riêng trong `docs/week-3-day-2.md`.
