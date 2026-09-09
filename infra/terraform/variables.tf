variable "aws_region" {
  description = "AWS region for the week-one control-plane foundation."
  type        = string
  default     = "ap-southeast-1"
}

variable "environment" {
  description = "Deployment environment."
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "environment must be development, staging, or production"
  }
}

variable "name_prefix" {
  description = "Short globally recognizable resource prefix."
  type        = string
  default     = "argus"
}

variable "vpc_cidr" {
  description = "Control-plane VPC range."
  type        = string
  default     = "10.40.0.0/16"
}

variable "cognito_domain_prefix" {
  description = "Globally unique Cognito hosted-UI prefix; leave empty to skip the domain."
  type        = string
  default     = ""
}

variable "cognito_callback_urls" {
  description = "Allowed OIDC callback URLs."
  type        = list(string)
  default     = ["http://localhost:3000/api/auth/callback"]
}

variable "cognito_logout_urls" {
  description = "Allowed post-logout URLs."
  type        = list(string)
  default     = ["http://localhost:3000/login"]
}
