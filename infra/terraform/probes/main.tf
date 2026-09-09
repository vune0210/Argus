module "singapore" {
  source            = "./modules/probe-region"
  providers         = { aws = aws.singapore }
  environment       = var.environment
  control_plane_url = var.control_plane_url
  image_digest      = var.image_digest
  desired_count     = var.desired_count
  token_secret_arn  = var.probe_secret_arns["ap-southeast-1"]
  kms_key_arn       = lookup(var.probe_kms_key_arns, "ap-southeast-1", null)
  vpc_cidr          = "10.51.0.0/16"
}
module "tokyo" {
  source            = "./modules/probe-region"
  providers         = { aws = aws.tokyo }
  environment       = var.environment
  control_plane_url = var.control_plane_url
  image_digest      = var.image_digest
  desired_count     = var.desired_count
  token_secret_arn  = var.probe_secret_arns["ap-northeast-1"]
  kms_key_arn       = lookup(var.probe_kms_key_arns, "ap-northeast-1", null)
  vpc_cidr          = "10.52.0.0/16"
}
module "frankfurt" {
  source            = "./modules/probe-region"
  providers         = { aws = aws.frankfurt }
  environment       = var.environment
  control_plane_url = var.control_plane_url
  image_digest      = var.image_digest
  desired_count     = var.desired_count
  token_secret_arn  = var.probe_secret_arns["eu-central-1"]
  kms_key_arn       = lookup(var.probe_kms_key_arns, "eu-central-1", null)
  vpc_cidr          = "10.53.0.0/16"
}
output "regions" {
  value = { ap-southeast-1 = module.singapore.deployment, ap-northeast-1 = module.tokyo.deployment, eu-central-1 = module.frankfurt.deployment }
}
