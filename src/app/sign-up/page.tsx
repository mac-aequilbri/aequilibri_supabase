// In-app sign-up — counterpart to /sign-in. An account alone grants nothing:
// org access requires an active membership row, operator rights require
// PLATFORM_ADMIN_EMAILS. Fail-closed by membership, same as under Clerk.

import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/platform/authConfig";
import { SignUpForm } from "./SignUpForm";

export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  if (!authEnabled()) redirect("/");
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 px-4">
      <SignUpForm />
    </div>
  );
}
