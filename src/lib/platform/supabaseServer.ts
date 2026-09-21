// Server-side Supabase Auth clients (@supabase/ssr cookie sessions).
//
// Two constructors for the two server contexts:
//  - serverSupabase(): RSC / server actions / route handlers, on next/headers
//    cookies(). Cookie WRITES throw inside a pure RSC render — swallowed here
//    because the proxy refreshes sessions on every matched request anyway.
//  - adminSupabase(): service-role client for admin ops (user invites).
//    SUPABASE_SERVICE_ROLE_KEY bypasses RLS — Secrets Manager only, never
//    NEXT_PUBLIC, never imported from client components.

import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { authEnabled } from "./authConfig";

export async function serverSupabase() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // RSC render — writes are not allowed here; the proxy owns refresh.
          }
        },
      },
    },
  );
}

/** The signed-in user's email (lowercased), or null. Validates the session
 *  against the auth server (not just the cookie) — same trust level the
 *  Clerk currentUser() call provided. */
export async function serverAuthEmail(): Promise<string | null> {
  if (!authEnabled()) return null;
  const supabase = await serverSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.email?.toLowerCase() ?? null;
}

export function adminSupabase() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!authEnabled() || !key) return null;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
