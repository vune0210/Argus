terraform {
  required_version = ">= 1.10.0"
  backend "s3" {}
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.0, < 7.0" }
  }
}

provider "aws" {
  alias  = "singapore"
  region = "ap-southeast-1"
}
provider "aws" {
  alias  = "tokyo"
  region = "ap-northeast-1"
}
provider "aws" {
  alias  = "frankfurt"
  region = "eu-central-1"
}
