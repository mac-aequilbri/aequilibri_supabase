"use client";

import { useState } from "react";
import { browserSupabase } from "@/lib/platform/supabaseBrowser";

export function ResetPasswordForm({ email }: { email: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error } = await browserSupabase().auth.updateUser({ password });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    window.location.assign("/app");
  }

  return (
    <form onSubmit={save} className="ae-card p-8 w-full max-w-sm space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Set a new password</h1>
        <p className="text-sm text-neutral-500 mt-1">for {email}</p>
      </div>
      <label className="block text-sm">
        <span className="text-neutral-700">New password</span>
        <input
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded border border-neutral-300 px-3 py-2"
        />
      </label>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <button type="submit" disabled={busy} className="btn-ae w-full">
        {busy ? "Saving…" : "Save password"}
      </button>
    </form>
  );
}
