# Customer-managed key for S3 buckets + Secrets Manager entries.
# Default key policy (account root) → access is delegated to IAM policies,
# every use is CloudTrail-logged, rotation is automatic.
resource "aws_kms_key" "main" {
  description             = "aequilibri prod CMK (S3 + Secrets Manager)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "main" {
  name          = "alias/${var.name_prefix}"
  target_key_id = aws_kms_key.main.key_id
}
