"use client";

import { useState } from "react";
import Link from "next/link";
import { browserSupabase } from "@/lib/platform/supabaseBrowser";

// Only same-origin paths may be used as a post-sign-in target — a full URL
// here would be an open-redirect vector.
function safePath(p: string): string {
  return p.startsWith("/") && !p.startsWith("//") ? p : "/app";
}

export function SignInForm({ redirectUrl }: { redirectUrl: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    const { error } = await browserSupabase().auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    // Hard navigation so the proxy + server components see the new session.
    window.location.assign(safePath(redirectUrl));
  }

  async function forgotPassword() {
    setError(null);
    if (!email.trim()) {
      setError("Enter your email address first, then click “Forgot password?”.");
      return;
    }
    const { error } = await browserSupabase().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/confirm?next=/reset-password`,
    });
    setNotice(error ? error.message : "Password reset email sent — check your inbox.");
  }

  return (
    <form onSubmit={signIn} className="ae-card p-8 w-full max-w-sm space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Sign in to æquilibri</h1>
        <p className="text-sm text-neutral-500 mt-1">Welcome back — please sign in to continue.</p>
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
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded border border-neutral-300 px-3 py-2"
        />
      </label>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}
      <button type="submit" disabled={busy} className="btn-ae w-full">
        {busy ? "Signing in…" : "Continue"}
      </button>
      <div className="flex items-center justify-between text-sm">
        <button type="button" onClick={forgotPassword} className="text-neutral-500 hover:text-neutral-800">
          Forgot password?
        </button>
        <Link href="/sign-up" className="text-neutral-500 hover:text-neutral-800">
          Sign up
        </Link>
      </div>
    </form>
  );
}
