github_repo = "mac-aequilbri/aequilibri_supabase"

# Actual sub claim observed in this repo's OIDC tokens (ID-hardened format).
github_oidc_sub   = "repo:mac-aequilbri@286524426/aequilibri_supabase@1333867357:ref:refs/heads/main"
app_desired_count = 1

# NS delegation live since 2026-08-17 — never apply with this false.
enable_https = true

platform_admin_emails = "mac@aequilibri.com"

# Transition (B-auth-5 removes): last Clerk-built image still reads this.
clerk_publishable_key = "pk_test_ZnJhbmstZG9yeS0yOC5jbGVyay5hY2NvdW50cy5kZXYk"

# Supabase Auth on the control project — both values public by design.
supabase_url      = "https://xpiqrxveestyeaxsebdu.supabase.co"
supabase_anon_key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhwaXFyeHZlZXN0eWVheHNlYmR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2ODY2OTEsImV4cCI6MjEwMjI2MjY5MX0.jGTVvA7s_yK1-ytHs8i6zqJIVuH62jkY8RfB50gBe4A"
