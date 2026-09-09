mock_provider "aws" {
  alias = "singapore"
  mock_data "aws_region" { defaults = { name = "ap-southeast-1" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_availability_zones" { defaults = { names = ["ap-southeast-1a", "ap-southeast-1b"] } }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/argus-ap-southeast-1" } }
  mock_resource "aws_ecr_repository" { defaults = { repository_url = "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/argus-staging-probe", arn = "arn:aws:ecr:ap-southeast-1:123456789012:repository/argus-staging-probe" } }
  mock_resource "aws_cloudwatch_log_group" { defaults = { arn = "arn:aws:logs:ap-southeast-1:123456789012:log-group:/argus/staging/probe" } }
}
mock_provider "aws" {
  alias = "tokyo"
  mock_data "aws_region" { defaults = { name = "ap-northeast-1" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_availability_zones" { defaults = { names = ["ap-northeast-1a", "ap-northeast-1b"] } }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/argus-ap-northeast-1" } }
  mock_resource "aws_ecr_repository" { defaults = { repository_url = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/argus-staging-probe", arn = "arn:aws:ecr:ap-northeast-1:123456789012:repository/argus-staging-probe" } }
  mock_resource "aws_cloudwatch_log_group" { defaults = { arn = "arn:aws:logs:ap-northeast-1:123456789012:log-group:/argus/staging/probe" } }
}
mock_provider "aws" {
  alias = "frankfurt"
  mock_data "aws_region" { defaults = { name = "eu-central-1" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_availability_zones" { defaults = { names = ["eu-central-1a", "eu-central-1b"] } }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/argus-eu-central-1" } }
  mock_resource "aws_ecr_repository" { defaults = { repository_url = "123456789012.dkr.ecr.eu-central-1.amazonaws.com/argus-staging-probe", arn = "arn:aws:ecr:eu-central-1:123456789012:repository/argus-staging-probe" } }
  mock_resource "aws_cloudwatch_log_group" { defaults = { arn = "arn:aws:logs:eu-central-1:123456789012:log-group:/argus/staging/probe" } }
}
variables {
  control_plane_url = "https://api.argus.example.com"
  image_digest      = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  desired_count     = 1
  probe_secret_arns = {
    ap-southeast-1 = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:argus-probe-test"
    ap-northeast-1 = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:argus-probe-test"
    eu-central-1   = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:argus-probe-test"
  }
}
run "three_independent_regions" {
  command = apply
  assert {
    condition     = output.regions["ap-southeast-1"].region == "ap-southeast-1" && output.regions["ap-northeast-1"].region == "ap-northeast-1" && output.regions["eu-central-1"].region == "eu-central-1"
    error_message = "Modules must use distinct regional providers."
  }
  assert {
    condition     = alltrue([for deployment in values(output.regions) : deployment.service != null && deployment.image_digest == var.image_digest])
    error_message = "All three services must use the same pinned artifact."
  }
}
run "repositories_before_release" {
  command = plan
  variables {
    image_digest  = ""
    desired_count = 0
  }
  assert {
    condition     = alltrue([for deployment in values(output.regions) : deployment.service == null])
    error_message = "Bootstrap must not start unpinned workloads."
  }
}
