// Set a new password. Reached from a recovery (or invite) email link, which
// establishes a session via /auth/confirm before landing here.

import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/platform/authConfig";
import { getAuthEmail } from "@/lib/platform/org-context";
import { ResetPasswordForm } from "./ResetPasswordForm";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage() {
  if (!authEnabled()) redirect("/");
  const email = await getAuthEmail();
  // No session → the link was stale; restart from sign-in's forgot-password.
  if (!email) redirect("/sign-in");
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 px-4">
      <ResetPasswordForm email={email} />
    </div>
  );
}
