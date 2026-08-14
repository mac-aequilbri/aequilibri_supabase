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

# GitHub issues this repo an ID-hardened OIDC subject
# (repo:<owner>@<owner_id>/<repo>@<repo_id>:ref:...). When set, the trust
# policy pins this exact subject (stronger: survives repo-name-reuse attacks;
# needs updating if the repo is ever renamed). Empty = classic format.
variable "github_oidc_sub" {
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

# Clerk publishable key — public by design (shipped in every client bundle),
# so a plain variable, not a secret. Server code also reads it at runtime to
# decide whether Clerk is enabled.
variable "clerk_publishable_key" {
  type    = string
  default = ""
}

# Flip to true AFTER the app.aequilibri.com NS delegation exists at
# Squarespace: validates the ACM cert, adds the :443 listener, turns :80
# into a 301 redirect, creates the Route53 alias, and attaches the WAF.
variable "enable_https" {
  type    = bool
  default = false
}

# Comma-separated emails allowed to provision customer organisations in-app.
variable "platform_admin_emails" {
  type    = string
  default = ""
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
