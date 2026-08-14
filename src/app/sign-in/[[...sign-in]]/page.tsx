// In-app sign-in (replaces Clerk's hosted Account Portal for this flow).
// Keeping auth on our own origin avoids the portal's cross-domain redirect
// validation entirely — the dev-instance portal refused to return users to
// the ALB origin regardless of allowlisting.

import { SignIn } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import { clerkEnabled } from "@/lib/platform/authConfig";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  // Without Clerk configured there is nothing to render (and no provider).
  if (!clerkEnabled()) redirect("/");
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50">
      <SignIn path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/app" />
    </div>
  );
}
