github_repo = "mac-aequilbri/aequilibri_supabase"

# Actual sub claim observed in this repo's OIDC tokens (ID-hardened format).
github_oidc_sub = "repo:mac-aequilbri@286524426/aequilibri_supabase@1333867357:ref:refs/heads/main"
app_desired_count = 1

# Public by design (ships in every client bundle) — dev instance for bring-up;
# swap for the pk_live_ key when the Clerk prod instance exists (needs domain).
clerk_publishable_key = "pk_test_ZnJhbmstZG9yeS0yOC5jbGVyay5hY2NvdW50cy5kZXYk"

platform_admin_emails = "mac@aequilibri.com"
