// In-app sign-in (Supabase Auth; own-origin pages — never a hosted portal,
// see the 2026-09-21 Clerk redirect saga in docs/auth-supabase-migration-plan.md).

import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/platform/authConfig";
import { SignInForm } from "./SignInForm";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string }>;
}) {
  // Without auth configured there is nothing to render.
  if (!authEnabled()) redirect("/");
  const { redirect_url } = await searchParams;
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 px-4">
      <SignInForm redirectUrl={redirect_url || "/app"} />
    </div>
  );
}
