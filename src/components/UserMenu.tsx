"use client";

// Signed-in indicator + sign-out for the navbar (replaces Clerk's UserButton).
// Sign-out clears the cookie session, then hard-navigates so every server
// component re-renders signed out.

import { useState } from "react";
import { browserSupabase } from "@/lib/platform/supabaseBrowser";

export function UserMenu({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-[var(--ae-earth)] max-w-[16rem] truncate" title={email}>
        {email}
      </span>
      <button
        type="button"
        className="btn-ae-outline text-sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await browserSupabase().auth.signOut();
          } finally {
            window.location.assign("/");
          }
        }}
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
