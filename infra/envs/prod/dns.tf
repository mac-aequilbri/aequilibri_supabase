# app.aequilibri.com — delegated subdomain (parent zone stays at Squarespace;
# four NS records for "app" point here). ACM cert is DNS-validated inside
# this zone, so issuance + renewal are fully automatic once delegation is live.
#
# Two-stage bring-up: apply once to create the zone (grab the NS records from
# the zone_name_servers output) → add them at Squarespace → set
# enable_https = true and apply again (cert validates, listeners flip, alias
# + WAF attach).

locals {
  app_fqdn = "app.aequilibri.com"
}

resource "aws_route53_zone" "app" {
  name    = local.app_fqdn
  comment = "aequilibri app subdomain (delegated from Squarespace DNS)"
}

resource "aws_acm_certificate" "app" {
  domain_name       = local.app_fqdn
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.app.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }
  zone_id = aws_route53_zone.app.zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 300
  records = [each.value.record]
}

# Waits until ACM actually issues the cert — only possible after the NS
# delegation exists, hence the enable_https gate.
resource "aws_acm_certificate_validation" "app" {
  count                   = var.enable_https ? 1 : 0
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_route53_record" "app_alias" {
  count   = var.enable_https ? 1 : 0
  zone_id = aws_route53_zone.app.zone_id
  name    = local.app_fqdn
  type    = "A"
  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

output "zone_name_servers" {
  description = "Add these four as NS records for host 'app' at Squarespace DNS"
  value       = aws_route53_zone.app.name_servers
}

output "app_url" {
  value = var.enable_https ? "https://${local.app_fqdn}" : "http://${aws_lb.main.dns_name} (HTTPS pending NS delegation)"
}
