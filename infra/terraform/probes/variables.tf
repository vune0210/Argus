variable "environment" {
  type    = string
  default = "staging"
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Managed probes require staging or production."
  }
}
variable "control_plane_url" {
  type = string
  validation {
    condition     = can(regex("^https://[^/@:]+(:443)?/?$", var.control_plane_url)) && !strcontains(var.control_plane_url, ".invalid")
    error_message = "Use the real HTTPS control-plane origin on port 443 without credentials or a path."
  }
}
variable "image_digest" {
  description = "Identical OCI manifest digest copied to all three ECR repositories. Empty only for repository bootstrap."
  type        = string
  default     = ""
}
variable "desired_count" {
  type    = number
  default = 0
  validation {
    condition     = floor(var.desired_count) == var.desired_count && var.desired_count >= 0 && var.desired_count <= 10
    error_message = "desired_count must be an integer from 0 to 10."
  }
}
variable "probe_secret_arns" {
  description = "Existing region-local Secrets Manager token ARNs; never secret values."
  type = object({
    ap-southeast-1 = string
    ap-northeast-1 = string
    eu-central-1   = string
  })
}
variable "probe_kms_key_arns" {
  description = "Optional region-local customer KMS key for each token secret."
  type        = map(string)
  default     = {}
}
