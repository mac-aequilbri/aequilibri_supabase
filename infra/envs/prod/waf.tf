# WAF on the ALB: AWS managed rule sets + a per-IP rate limit.
# ENFORCING since 2026-09-22 after a month of count-mode observation (owner
# call): every sampled hit was bot exploitation (Exchange probes, the React
# RCE campaign), zero legitimate traffic flagged. One deliberate exception:
# SizeRestrictions_BODY stays in count mode — it false-positives on
# legitimate large POST bodies (document/logo uploads via server actions).
# Revisit when n8n/EventBridge get wired to the outbox endpoints.

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
        none {} # enforcing — the group's own rule actions (block) apply
      }
      statement {
        managed_rule_group_statement {
          name        = rule.value.name
          vendor_name = "AWS"

          # Upload-safety carve-out: body-size limits count, never block.
          dynamic "rule_action_override" {
            for_each = rule.value.name == "AWSManagedRulesCommonRuleSet" ? ["SizeRestrictions_BODY"] : []
            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }
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
      block {} # 2000 req / 5 min per IP — never once tripped in observation
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
