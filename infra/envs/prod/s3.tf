# Three app buckets. All: CMK-encrypted, public access blocked, TLS-only.
# documents  — the S3 document storer (B1); versioned.
# attachments — migration binaries + manifests; → IA after 90d.
# backups    — weekly logical pg_dumps + final Airtable export; versioned,
#              → Glacier after 30d.

locals {
  buckets = {
    documents = {
      versioned = true
      lifecycle = []
    }
    attachments = {
      versioned = false
      lifecycle = [{ days = 90, storage_class = "STANDARD_IA" }]
    }
    backups = {
      versioned = true
      lifecycle = [{ days = 30, storage_class = "GLACIER" }]
    }
  }
}

resource "aws_s3_bucket" "app" {
  for_each = local.buckets
  bucket   = "${var.name_prefix}-${each.key}"
}

resource "aws_s3_bucket_versioning" "app" {
  for_each = { for k, v in local.buckets : k => v if v.versioned }
  bucket   = aws_s3_bucket.app[each.key].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "app" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.app[each.key].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "app" {
  for_each                = local.buckets
  bucket                  = aws_s3_bucket.app[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "app" {
  for_each = { for k, v in local.buckets : k => v if length(v.lifecycle) > 0 }
  bucket   = aws_s3_bucket.app[each.key].id
  rule {
    id     = "transition"
    status = "Enabled"
    filter {}
    dynamic "transition" {
      for_each = each.value.lifecycle
      content {
        days          = transition.value.days
        storage_class = transition.value.storage_class
      }
    }
  }
}

data "aws_iam_policy_document" "tls_only" {
  for_each = local.buckets
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.app[each.key].arn, "${aws_s3_bucket.app[each.key].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "tls_only" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.app[each.key].id
  policy   = data.aws_iam_policy_document.tls_only[each.key].json
}
