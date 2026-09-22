# dev.app.aequilibri.com — lives inside the prod stack's hosted zone (looked
# up by name, not remote state), so no new delegation is needed anywhere.

data "aws_route53_zone" "app" {
  name = "app.aequilibri.com"
}

locals {
  dev_fqdn = "dev.app.aequilibri.com"
}

resource "aws_acm_certificate" "dev" {
  domain_name       = local.dev_fqdn
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.dev.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }
  zone_id = data.aws_route53_zone.app.zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 300
  records = [each.value.record]
}

resource "aws_acm_certificate_validation" "dev" {
  certificate_arn         = aws_acm_certificate.dev.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_route53_record" "dev_alias" {
  zone_id = data.aws_route53_zone.app.zone_id
  name    = local.dev_fqdn
  type    = "A"
  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
