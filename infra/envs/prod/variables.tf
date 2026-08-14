variable "aws_region" {
  type    = string
  default = "ap-southeast-2"
}

variable "name_prefix" {
  type    = string
  default = "aequilibri-prod"
}

# "<org>/<repo>" once the GitHub repo exists. Empty string skips the OIDC
# provider + CI deploy role entirely (they apply cleanly later).
variable "github_repo" {
  type    = string
  default = ""
}

# 0 until the first image is in ECR (nothing to run yet); flip to 1 after
# the first push/deploy. The scheduler lock & caches are per-process —
# NEVER set this above 1 without a shared Redis (hardening audit pin).
variable "app_desired_count" {
  type    = number
  default = 0
  validation {
    condition     = var.app_desired_count <= 1
    error_message = "Single-instance pin: >1 task is unsafe until a shared Redis exists."
  }
}

# Moving tags the committed deploy.yml pushes on every main build; the task
# definitions pin these and `--force-new-deployment` picks up the new image.
variable "app_image_tag" {
  type    = string
  default = "latest"
}
variable "migrate_image_tag" {
  type    = string
  default = "migrate"
}

variable "alarm_email" {
  type    = string
  default = "mac@aequilibri.com"
}

variable "monthly_budget_usd" {
  type    = string
  default = "250"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}
