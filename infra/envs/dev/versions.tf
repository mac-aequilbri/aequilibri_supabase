# DEV stack — a trimmed mirror of ../prod (see docs/dev-environment-plan.md
# for the deliberate deltas: no account baseline, no WAF, no backups, no
# scheduler, no alarms, scale-to-zero compute).

terraform {
  required_version = ">= 1.10"

  backend "s3" {
    bucket       = "aequilibri-prod-tfstate" # shared state bucket, separate key
    key          = "dev/terraform.tfstate"
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
    tags = { Project = "aequilibri", Env = "dev", ManagedBy = "terraform" }
  }
}

data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}
