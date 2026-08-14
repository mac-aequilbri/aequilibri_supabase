terraform {
  required_version = ">= 1.10"

  backend "s3" {
    bucket       = "aequilibri-prod-tfstate" # created by infra/bootstrap
    key          = "prod/terraform.tfstate"
    region       = "ap-southeast-2"
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = { Project = "aequilibri", Env = "prod", ManagedBy = "terraform" }
  }
}

data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}
