resource "aws_sns_topic" "alarms" {
  name = "${var.name_prefix}-alarms"
}

# Explicit topic policy: keep the default same-account access AND let
# EventBridge publish (needed for the GuardDuty findings rule; CloudWatch
# alarms publish via the account statement).
data "aws_iam_policy_document" "alarms_topic" {
  statement {
    sid = "DefaultAccountAccess"
    actions = [
      "SNS:Publish",
      "SNS:Subscribe",
      "SNS:GetTopicAttributes",
      "SNS:SetTopicAttributes",
      "SNS:ListSubscriptionsByTopic",
      "SNS:AddPermission",
      "SNS:RemovePermission",
      "SNS:DeleteTopic",
      "SNS:Receive"
    ]
    resources = [aws_sns_topic.alarms.arn]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceOwner"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
  statement {
    sid       = "AllowEventBridgePublish"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.alarms.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alarms" {
  arn    = aws_sns_topic.alarms.arn
  policy = data.aws_iam_policy_document.alarms_topic.json
}

resource "aws_sns_topic_subscription" "alarm_email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email # confirm the subscription email once
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  # Muted while prod sleeps (desired_count 0): a target-less ALB 5xxes on
  # every bot request.
  actions_enabled     = var.app_desired_count > 0
  alarm_name          = "${var.name_prefix}-alb-5xx"
  alarm_description   = "ALB returned >=5 5xx in 5 minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  actions_enabled     = var.app_desired_count > 0 # muted while prod sleeps
  alarm_name          = "${var.name_prefix}-unhealthy-targets"
  alarm_description   = "App target failing the /api/health check"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.app.arn_suffix
  }
  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

# Crash-loop detector. notBreaching while desired_count = 0 (pre-first-deploy);
# meaningful once the service runs.
resource "aws_cloudwatch_metric_alarm" "task_count" {
  actions_enabled     = var.app_desired_count > 0 # muted while prod sleeps (0 running is intended)
  alarm_name          = "${var.name_prefix}-no-running-task"
  alarm_description   = "ECS service has no running task for 5 minutes"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.app.name
  }
  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}
