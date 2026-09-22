# Dev environment (separated dev/prod for AWS + Supabase)

**Status:** DONE — decided, built, and verified 2026-09-22 (health + auth gate + sign-in confirmed at https://dev.app.aequilibri.com, then scaled to zero). Gotcha for posterity: a deploy job with `environment:` changes the GitHub OIDC sub claim to `environment:<name>` — the CI role trust is environment-pinned now.
**Driver:** every push to main currently deploys straight to the app the
client uses. A deployable dev environment takes that risk out before real
client work lands.

**Owner decisions (2026-09-22):**
- AWS: same account, separate stack (`infra/envs/dev`), everything tagged
  `Env=dev`. No second account/Organizations ceremony.
- Supabase: dev projects in the existing Pro org (`aequilibri-control-dev`,
  `aequilibri-t-default-dev`, Sydney) — ~US$20/mo compute, no auto-pause.
- Compute: **scale-to-zero** (`app_desired_count = 0` default; flip to 1 to
  use dev, back to 0 when done). Standing dev cost ≈ ALB + NAT + logs.
- CI: push to **`dev` branch → dev environment**; merge dev→main → prod.

## Shape (deltas from prod — everything else mirrors it)

| Piece | Dev | Why different |
|---|---|---|
| Domain | `dev.app.aequilibri.com` | lives INSIDE the existing app.aequilibri.com hosted zone — no Squarespace delegation needed |
| VPC | own (10.30.0.0/16), 1 NAT, endpoints | isolation with parity |
| ECR | SHARED repo, `dev-<sha>` / `dev-latest` tags | one registry, no CI fork |
| Secrets | `aequilibri/dev/*`, all fresh | never share prod credentials (interim exception: ANTHROPIC_API_KEY copied from prod until a dev key is minted — owner TODO) |
| Account baseline | none | CloudTrail/GuardDuty/Config/Security Hub/budget are account-wide — already active |
| WAF | none | dev is auth-gated and obscure; saves cost/noise |
| Backups, weekly dumps | none | dev data is synthetic/disposable |
| EventBridge scheduler | none | trigger manually when testing automation |
| Alarms/SNS | none | dev failures are observed interactively |
| Auth | Supabase Auth on control-dev (email/password; Google optional — add the dev callback URI to the GCP OAuth client if wanted) | separate user pool from prod |

## CI/CD

`deploy.yml` triggers on `main` + `dev`; the deploy job selects a GitHub
**environment** (`prod` / `dev`) by branch, and all deploy-time values
(cluster, service, migrate task family, network config, Supabase URL/anon
key) come from environment-scoped variables. Image tags are prefixed
`dev-` for dev builds. The existing OIDC deploy role trusts both
`refs/heads/main` and `refs/heads/dev` and may act on both stacks.

## On/off switch (scale-to-zero)

- Up:   `terraform -chdir=infra/envs/dev apply -var app_desired_count=1`
- Down: same with `0` (or just leave it — idle dev costs no Fargate).

## Sequence

1. Supabase: create + migrate the two dev projects, bootstrap
   `aequilibri_app`, configure auth (site_url = dev URL).
2. `infra/envs/dev` stack (state key `dev/terraform.tfstate`, same bucket).
3. Widen the CI role (dev branch trust + dev resources); GitHub
   environments + variables; `deploy.yml` branch switch; create `dev` branch.
4. Fill `aequilibri/dev/*` secrets (fresh internals, dev DB URLs, dev
   service-role key; Anthropic copied — see TODO above).
5. First dev deploy from the `dev` branch; verify health + sign-in at
   https://dev.app.aequilibri.com; scale back to 0.
