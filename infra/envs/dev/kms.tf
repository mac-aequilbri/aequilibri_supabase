resource "aws_kms_key" "main" {
  description             = "aequilibri dev CMK (S3 + Secrets Manager)"
  enable_key_rotation     = true
  deletion_window_in_days = 7
}

resource "aws_kms_alias" "main" {
  name          = "alias/${var.name_prefix}"
  target_key_id = aws_kms_key.main.key_id
}
