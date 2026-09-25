github_repo = "mac-aequilbri/aequilibri_supabase"

# Actual sub claim observed in this repo's OIDC tokens (ID-hardened format).
github_oidc_sub = "repo:mac-aequilbri@286524426/aequilibri_supabase@1333867357:ref:refs/heads/main"
# Pre-launch (owner decision 2026-09-25): prod sleeps like dev until the
# first real client. 0 also DISABLES the hourly scheduler rule and mutes the
# app-coupled alarms (see scheduler.tf / observability.tf). Wake with:
#   terraform -chdir=infra/envs/prod apply -var app_desired_count=1
app_desired_count = 0

# NS delegation live since 2026-08-17 — never apply with this false.
enable_https = true

platform_admin_emails = "mac@aequilibri.com"

# Supabase Auth on the control project — both values public by design.
supabase_url      = "https://xpiqrxveestyeaxsebdu.supabase.co"
supabase_anon_key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhwaXFyeHZlZXN0eWVheHNlYmR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2ODY2OTEsImV4cCI6MjEwMjI2MjY5MX0.jGTVvA7s_yK1-ytHs8i6zqJIVuH62jkY8RfB50gBe4A"
