# MUTABLE because the committed CI flow (deploy.yml) deploys by re-pushing
# the moving tags :latest / :migrate + force-new-deployment. Hardening step
# for later: switch CI to register task-def revisions pinned to :<sha> tags,
# then flip this to IMMUTABLE.
resource "aws_ecr_repository" "app" {
  name                 = "aequilibri-app"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
