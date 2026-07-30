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
    // The suites must not depend on the developer's local .env: Clerk keys are
    // blanked because they assume demo-mode auth ("no Clerk in tests"), and
    // @clerk/nextjs/server's `server-only` guard throws under vitest if a
    // local .env activates clerkEnabled().
    env: {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
      CLERK_SECRET_KEY: "",
    },
  },
});
