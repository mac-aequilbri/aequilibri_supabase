variable "aws_region" {
  type    = string
  default = "ap-southeast-2"
}

variable "name_prefix" {
  type    = string
  default = "aequilibri-dev"
}

# Scale-to-zero by default (owner decision 2026-09-22): flip to 1 to use dev.
#   terraform -chdir=infra/envs/dev apply -var app_desired_count=1
variable "app_desired_count" {
  type    = number
  default = 0
  validation {
    condition     = var.app_desired_count <= 1
    error_message = "Single-instance pin applies to dev too (per-process scheduler lock/caches)."
  }
}

# Moving tags the dev deploy pushes (dev-<sha> + these).
variable "app_image_tag" {
  type    = string
  default = "dev-latest"
}
variable "migrate_image_tag" {
  type    = string
  default = "dev-migrate"
}

variable "platform_admin_emails" {
  type    = string
  default = ""
}

# Supabase Auth (control-dev project) — public by design.
variable "supabase_url" {
  type    = string
  default = ""
}
variable "supabase_anon_key" {
  type    = string
  default = ""
}

variable "vpc_cidr" {
  type    = string
  default = "10.30.0.0/16"
}
