import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The suite asserts the Postgres-mode guarantees the Airtable migration
    // deliberately preserves (org-isolation guard, approval-time re-validation,
    // integer record ids). It must not depend on the developer's local .env,
    // where AIRTABLE_MIGRATION=true would route writes to the shared demo base
    // (one base for every test org → cross-org isolation can't hold; string
    // "rec…" ids break Postgres lookups). Airtable-mode writes are proven
    // separately by scripts/airtable-write-proof.mjs against the demo base.
    // Clerk keys are blanked for the same reason: the suites assume demo-mode
    // auth ("no Clerk in tests"), and @clerk/nextjs/server's `server-only`
    // guard throws under vitest if a local .env activates clerkEnabled().
    env: {
      AIRTABLE_MIGRATION: "false",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
      CLERK_SECRET_KEY: "",
    },
  },
});
