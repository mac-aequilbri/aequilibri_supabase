# Hourly platform scheduler (plan A9): EventBridge rule → API destination →
# POST https://app.aequilibri.com/api/platform/scheduler with
# `Authorization: Bearer <CRON_SECRET>`.
#
# SECRET HANDLING: the connection is created with a PLACEHOLDER header value
# and `ignore_changes` on auth — the real value is set once, out-of-band:
#   aws events update-connection --name aequilibri-prod-scheduler \
#     --auth-parameters '{"ApiKeyAuthParameters":{"ApiKeyName":"Authorization",
#                         "ApiKeyValue":"Bearer <CRON_SECRET from ASM>"}}'
# so CRON_SECRET never enters Terraform state. EventBridge stores it in its
# own Secrets Manager entry either way.

resource "aws_cloudwatch_event_connection" "scheduler" {
  name               = "${var.name_prefix}-scheduler"
  description        = "Bearer auth for the platform scheduler endpoint"
  authorization_type = "API_KEY"

  auth_parameters {
    api_key {
      key   = "Authorization"
      value = "PLACEHOLDER-set-via-update-connection"
    }
  }

  lifecycle {
    # Real header value lives only in AWS; never reconciled from code.
    ignore_changes = [auth_parameters]
  }
}

resource "aws_cloudwatch_event_api_destination" "scheduler" {
  name                             = "${var.name_prefix}-scheduler"
  description                      = "POST /api/platform/scheduler (hourly)"
  invocation_endpoint              = "https://app.aequilibri.com/api/platform/scheduler"
  http_method                      = "POST"
  invocation_rate_limit_per_second = 1
  connection_arn                   = aws_cloudwatch_event_connection.scheduler.arn
}

resource "aws_cloudwatch_event_rule" "hourly_scheduler" {
  name                = "${var.name_prefix}-hourly-scheduler"
  description         = "Platform automation tick (top of every hour)"
  schedule_expression = "cron(0 * * * ? *)"
}

data "aws_iam_policy_document" "events_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler_invoke" {
  name               = "${var.name_prefix}-scheduler-invoke"
  assume_role_policy = data.aws_iam_policy_document.events_assume.json
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  name = "invoke-api-destination"
  role = aws_iam_role.scheduler_invoke.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["events:InvokeApiDestination"]
      Resource = aws_cloudwatch_event_api_destination.scheduler.arn
    }]
  })
}

resource "aws_cloudwatch_event_target" "hourly_scheduler" {
  rule     = aws_cloudwatch_event_rule.hourly_scheduler.name
  arn      = aws_cloudwatch_event_api_destination.scheduler.arn
  role_arn = aws_iam_role.scheduler_invoke.arn

  # A missed hour is tolerable (runs are idempotent via the app's scheduler
  # lock); don't let stale retries pile up.
  retry_policy {
    maximum_event_age_in_seconds = 600
    maximum_retry_attempts       = 2
  }
}

resource "aws_cloudwatch_metric_alarm" "scheduler_failed" {
  alarm_name          = "${var.name_prefix}-scheduler-failed"
  alarm_description   = "Hourly scheduler invocations failing (endpoint down or auth broken)"
  namespace           = "AWS/Events"
  metric_name         = "FailedInvocations"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { RuleName = aws_cloudwatch_event_rule.hourly_scheduler.name }
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
