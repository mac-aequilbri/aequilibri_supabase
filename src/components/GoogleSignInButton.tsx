"use client";

// "Continue with Google" via Supabase Auth (PKCE): Supabase redirects to
// Google and back to its own callback, then to our /auth/confirm with a
// ?code to exchange — the same landing the email links use. `next` must be a
// same-origin path (enforced by /auth/confirm and by the sign-in page).

import { useState } from "react";
import { browserSupabase } from "@/lib/platform/supabaseBrowser";

export function GoogleSignInButton({ next }: { next: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="btn-ae-outline w-full"
        onClick={async () => {
          setError(null);
          const { error } = await browserSupabase().auth.signInWithOAuth({
            provider: "google",
            options: {
              redirectTo: `${window.location.origin}/auth/confirm?next=${encodeURIComponent(next)}`,
            },
          });
          if (error) setError(error.message);
          // On success the browser navigates away; no further state to manage.
        }}
      >
        Continue with Google
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
