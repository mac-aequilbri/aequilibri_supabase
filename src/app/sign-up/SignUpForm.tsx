"use client";

import { useState } from "react";
import Link from "next/link";
import { browserSupabase } from "@/lib/platform/supabaseBrowser";

export function SignUpForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { data, error } = await browserSupabase().auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth/confirm?next=/app` },
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    // With email confirmation on, a session only exists after the link is
    // clicked; if confirmations are off we're already signed in.
    if (data.session) window.location.assign("/app");
    else setSent(true);
  }

  if (sent) {
    return (
      <div className="ae-card p-8 w-full max-w-sm space-y-3 text-center">
        <h1 className="text-xl font-semibold">Check your email</h1>
        <p className="text-sm text-neutral-600">
          We sent a confirmation link to <strong>{email}</strong>. Click it to finish creating your
          account.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={signUp} className="ae-card p-8 w-full max-w-sm space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Create your account</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Access to an organisation is granted by its administrator after sign-up.
        </p>
      </div>
      <label className="block text-sm">
        <span className="text-neutral-700">Email address</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded border border-neutral-300 px-3 py-2"
        />
      </label>
      <label className="block text-sm">
        <span className="text-neutral-700">Password</span>
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
        {busy ? "Creating…" : "Continue"}
      </button>
      <p className="text-sm text-neutral-500 text-center">
        Already have an account?{" "}
        <Link href="/sign-in" className="hover:text-neutral-800 underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
