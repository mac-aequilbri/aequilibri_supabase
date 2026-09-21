// Email-link landing for Supabase Auth: signup confirmations, invites, and
// password-recovery links all establish a session here, then bounce to
// `next`. Handles BOTH link flavors so the default Supabase email templates
// work unmodified:
//   ?code=…                    — default templates ({{ .ConfirmationURL }}):
//                                Supabase's verify endpoint redirects here
//                                with a PKCE code to exchange.
//   ?token_hash=…&type=…       — customized templates ({{ .TokenHash }}).
// Errors land on /sign-in with a notice rather than a bare 4xx — a stale link
// should read as "sign in again", not as a broken site.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { EmailOtpType } from "@supabase/supabase-js";

function safePath(p: string | null): string {
  return p && p.startsWith("/") && !p.startsWith("//") ? p : "/app";
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const next = safePath(searchParams.get("next"));
  const response = NextResponse.redirect(new URL(next, request.url));

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
      : { error: new Error("missing code/token_hash") };

  if (error) {
    const signIn = new URL("/sign-in", request.url);
    signIn.searchParams.set("redirect_url", next);
    return NextResponse.redirect(signIn);
  }
  return response;
}
