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

// Redirect with a RELATIVE Location. Behind the ALB, `request.url` in route
// handlers resolves to the container's internal hostname
// (ip-10-20-10-80.….compute.internal:3000), so absolute URLs built from it
// leak an unreachable address to the browser. Relative Locations are valid
// (RFC 7231) and resolve against the public origin the browser is already on.
function relativeRedirect(path: string): NextResponse {
  return new NextResponse(null, { status: 307, headers: { location: path } });
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const next = safePath(searchParams.get("next"));
  const response = relativeRedirect(next);

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
    return relativeRedirect(`/sign-in?redirect_url=${encodeURIComponent(next)}`);
  }
  return response;
}
