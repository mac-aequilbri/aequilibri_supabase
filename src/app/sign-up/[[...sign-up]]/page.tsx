// In-app sign-up — counterpart to /sign-in (see that page's rationale).

import { SignUp } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import { clerkEnabled } from "@/lib/platform/authConfig";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  if (!clerkEnabled()) redirect("/");
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50">
      <SignUp path="/sign-up" signInUrl="/sign-in" fallbackRedirectUrl="/app" />
    </div>
  );
}
