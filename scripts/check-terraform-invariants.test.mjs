import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const tfDir = resolve(rootDir, "infra/terraform");

const controlPlaneTf = readFileSync(resolve(tfDir, "control_plane.tf"), "utf8");
const executionTf = readFileSync(resolve(tfDir, "execution.tf"), "utf8");
const observabilityTf = readFileSync(resolve(tfDir, "observability.tf"), "utf8");
const mainTf = readFileSync(resolve(tfDir, "main.tf"), "utf8");

test("Terraform: Health check paths", () => {
  assert.match(controlPlaneTf, /path\s*=\s*"\/health\/ready"/, "API target group must check /health/ready");
  assert.match(controlPlaneTf, /path\s*=\s*"\/api\/health"/, "Web target group must check /api/health");
});

test("Terraform: Encryption in transit and at rest", () => {
  assert.match(controlPlaneTf, /storage_encrypted\s*=\s*true/, "RDS storage must be encrypted");
  assert.match(executionTf, /at_rest_encryption_enabled\s*=\s*true/, "Redis must have at-rest encryption enabled");
  assert.match(executionTf, /transit_encryption_enabled\s*=\s*true/, "Redis must have transit encryption enabled");
  assert.match(mainTf, /encryption_type\s*=\s*"AES256"/, "ECR must use AES256 encryption");
});

test("Terraform: Private networking and Redis subnet reuse", () => {
  assert.match(controlPlaneTf, /resource "aws_subnet" "app_private"/, "Must define app_private subnets");
  assert.match(controlPlaneTf, /resource "aws_subnet" "data_private"/, "Must define data_private subnets");
  assert.doesNotMatch(executionTf, /resource "aws_subnet" "execution_private"/, "Must not create redundant execution subnets");
  assert.match(executionTf, /subnet_ids\s*=\s*aws_subnet\.data_private\[\*\]\.id/, "Redis must use data_private subnets");
});

test("Terraform: Security group egress rules for DB (5432) and Redis (6379)", () => {
  assert.match(controlPlaneTf, /from_port\s*=\s*5432/, "Control plane SG must have egress rule for PostgreSQL 5432");
  assert.match(controlPlaneTf, /referenced_security_group_id\s*=\s*aws_security_group\.postgres\.id/);
  assert.match(executionTf, /from_port\s*=\s*6379/, "Control plane SG must have egress rule for Redis 6379");
  assert.match(executionTf, /referenced_security_group_id\s*=\s*aws_security_group\.redis\[0\]\.id/);
});

test("Terraform: Immutable digests and desired count gating", () => {
  assert.match(mainTf, /image_tag_mutability\s*=\s*"IMMUTABLE"/, "ECR repositories must be IMMUTABLE");
  assert.match(controlPlaneTf, /desired_count\s*=\s*\(var\.enable_control_plane_services && local\.has_digests\)/, "API/Web desired count must be gated on image digests");
  assert.match(executionTf, /var\.worker_image_digest != "" \?/, "Worker container definition must use worker_image_digest");
});

test("Terraform: IAM task role scope (no wildcards)", () => {
  assert.match(controlPlaneTf, /Action\s*=\s*\["secretsmanager:GetSecretValue"\]/);
  assert.doesNotMatch(controlPlaneTf, /Action\s*=\s*\["secretsmanager:GetSecretValue"\]\s*Resource\s*=\s*"\*"/, "Secrets Manager must not have wildcard Resource");
  assert.doesNotMatch(controlPlaneTf, /Action\s*=\s*\["ses:SendEmail"\]\s*Resource\s*=\s*"\*"/, "SES must not have wildcard Resource");
});

test("Terraform: CloudFront status origin secret header and separate certs", () => {
  assert.match(controlPlaneTf, /variable "alb_certificate_arn"/, "Must have distinct alb_certificate_arn");
  assert.match(controlPlaneTf, /variable "cloudfront_certificate_arn"/, "Must have distinct cloudfront_certificate_arn");
  assert.match(controlPlaneTf, /X-Argus-Status-Secret/, "CloudFront must add X-Argus-Status-Secret");
  assert.match(controlPlaneTf, /http_header_name\s*=\s*"X-Argus-Status-Secret"/, "ALB rule must match secret header");
  assert.match(controlPlaneTf, /resource "aws_route53_record" "status_origin"/, "Must define status-origin DNS record");
});

test("Terraform: Observability SNS topic and alarms", () => {
  assert.match(observabilityTf, /resource "aws_sns_topic" "staging_alarms"/, "Must define staging alarms SNS topic");
  assert.match(observabilityTf, /alarm_actions\s*=\s*\[aws_sns_topic\.staging_alarms\.arn\]/, "Alarms must send actions to SNS topic");
});
