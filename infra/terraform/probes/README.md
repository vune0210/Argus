# Three-region managed probes

This is an independent Terraform root/state, not a replacement for the control-plane stack or its optional week-two task definitions. Provider aliases bind Singapore, Tokyo and Frankfurt explicitly; all call one `modules/probe-region` module. No AWS resources were created during day-two verification: `terraform test` uses mock providers, including its `command = apply` run.

Each region gets an isolated VPC, two subnets/AZs, internet gateway/routes, security group with **no ingress**, ECR repository, CloudWatch logs, ECS cluster, execution IAM role, and (after an image digest is supplied) a task definition/service. Fargate tasks use public IPs for outbound connectivity, not for listening services; no peering to the database/control-plane VPC. Egress is limited to TCP 80/443, so arbitrary check ports remain unsupported in this deployment. The Go SSRF guard additionally blocks private/link-local/metadata targets and is never disabled in managed config.

The execution role can pull this region's ECR image, write this log group and read only the supplied local token secret. Optional KMS permission is constrained to Secrets Manager in the same region. The container has no AWS application task role, no Redis/database credentials, runs non-root with a read-only filesystem, and uses 256 CPU units / 512 MiB. It polls HTTPS and renews leases; it does not expose a readiness HTTP listener.

## Inputs required before a real AWS plan

- Separate remote-state key/bucket and permissions; copy `backend.hcl.example` into your untracked deployment config.
- Real HTTPS control-plane origin on port 443; replace the intentionally invalid example URL.
- Existing token secret ARN in each region/account, and optional local KMS key ARN. Token value format is `argp_managed-<region>.<private-random-value>` and the control plane must register the matching HMAC digest through the existing `probe:register` CLI using its secret-manager environment.
- GitHub repository metadata, OIDC publishing role, and protected `staging` / `production` environments. Put its ARN in environment variable configuration `ARGUS_PROBE_RELEASE_ROLE_ARN` (GitHub Actions environment **variable**, not a source file). OIDC trust must constrain the `repo:vune0210/Argus:environment:<environment>` subject and `sts.amazonaws.com` audience.

The publisher role needs ECR authorization plus BatchGetImage/DescribeRepositories and upload/PutImage operations on the three `argus-<environment>-probe` repositories. It needs no ECS, Secrets Manager or Terraform apply permissions. This workflow only distributes artifacts; it does not deploy them.

## Verification without AWS credentials

From the repository root, with Terraform available:

```powershell
terraform -chdir=infra/terraform/probes init -backend=false
terraform -chdir=infra/terraform/probes fmt -check -recursive
terraform -chdir=infra/terraform/probes validate
terraform -chdir=infra/terraform/probes test
```

Local verification used the existing `hashicorp/terraform:1.10.5` image and cached Linux AWS provider 6.63.0. The lock file currently contains the locally computed Linux checksum. Use the same Linux toolchain, or populate provider checksums for other platforms before using them. The compatible `aws_region.name` attribute produces a provider-6 deprecation warning, not a validation failure.

## Deployment sequence for day three (not executed)

1. Configure the real backend and environment `.tfvars`; initialize the separate state. Bootstrap plan uses `image_digest=""`, `desired_count=0`, so it creates repositories/network/IAM/logging without unpinned tasks.
2. Review/apply the bootstrap plan through the team's deployment workflow. Confirm the token registrations and HTTPS control-plane availability.
3. Manually dispatch **Prepare regional probe release** on the approved source revision. It builds one Linux/amd64 image with provenance disabled for a single manifest, saves that exact archive, and loads/pushes it in each region. Credentials are obtained via OIDC; registry login uses a temporary Docker config that is removed afterward.
4. The publish script compares the registry manifest's config digest against the config extracted from the saved archive. A rerun accepts an existing immutable tag only if it matches that artifact. The final job requires exactly three regions with one source revision/environment/manifest digest, and produces `verified-regional-release`.
5. Use the downloaded digest file **after** the environment file, so an empty bootstrap digest cannot override it:

```powershell
terraform -chdir=infra/terraform/probes plan -var-file=staging.tfvars -var-file=probe-release.auto.tfvars.json -var='desired_count=1' -out=regional-probes.tfplan
```

6. Review the saved plan and roll it out via the team's authorized AWS workflow. Check ECS service stability and actual task ARNs in all three regions, then create an authorized test monitor and confirm distinct regional results/ALIVE heartbeat through the snapshot API. Save image digest, task ARNs, log evidence and execution ID together.

ECS deployment circuit breaker has rollback enabled. For a confirmed application regression, re-plan with the **previous verified digest file** and the same environment/desired count; do not mutate tags or destroy the VPC/secrets. If no previous healthy revision exists, set desired count to zero, preserve the resources and diagnose task events/logs. Backend migration rollback is a separate operation documented in `docs/week-3-day-2.md`.

CloudWatch logs and worker partition-loop metrics are configured in source. Regional runtime alert wiring, IAM trust, secret existence, registry publishing, AWS plan/apply and ECS runtime remain day-three evidence requirements.
