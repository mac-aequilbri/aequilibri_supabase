# WAF on the ALB: AWS managed rule sets + a per-IP rate limit.
# All rules start in COUNT mode (observe, never block) — watch the metrics
# for a week for false positives on n8n polling and EventBridge, then remove
# the count overrides to enforce. Created with the HTTPS flip (enable_https).

resource "aws_wafv2_web_acl" "app" {
  count = var.enable_https ? 1 : 0
  name  = "${var.name_prefix}-waf"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = [
      { name = "AWSManagedRulesCommonRuleSet", priority = 1 },
      { name = "AWSManagedRulesKnownBadInputsRuleSet", priority = 2 },
      { name = "AWSManagedRulesAmazonIpReputationList", priority = 3 },
    ]
    content {
      name     = rule.value.name
      priority = rule.value.priority
      override_action {
        count {} # observe-only; remove to enforce
      }
      statement {
        managed_rule_group_statement {
          name        = rule.value.name
          vendor_name = "AWS"
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.value.name
        sampled_requests_enabled   = true
      }
    }
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 10
    action {
      count {} # observe-only; switch to block{} to enforce
    }
    statement {
      rate_based_statement {
        limit              = 2000 # requests per 5 min per IP
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit-per-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name_prefix}-waf"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  count        = var.enable_https ? 1 : 0
  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.app[0].arn
}
