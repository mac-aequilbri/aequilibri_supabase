import { NextResponse } from "next/server";
import type { NextRequest, NextFetchEvent } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { authEnabled, demoModeAllowed } from "@/lib/platform/authConfig";

// Next 16 renamed Middleware → Proxy (same behavior).
//
// Two concerns are layered here:
//  1. UC1 kill-switch (pre-existing): flip UC1_ENABLED to disable the roofing
//     app and its API.
//  2. Platform auth (Supabase Auth, cookie sessions via @supabase/ssr): when
//     auth is configured, everything under /app requires a signed-in user —
//     org membership and roles are then enforced in lib/platform/org-context.
//     This proxy also REFRESHES expired sessions on every matched request
//     (the only place cookie writes are always allowed), which is why the
//     matcher stays broad. The public client portal (/portal/[token]) and the
//     landing page stay unauthenticated by design. Without auth env the
//     platform runs in open demo mode only with the explicit opt-in below.
const UC1_ENABLED = true;

const isPlatformRoute = createRouteMatcher(["/app", "/app/(.*)"]);
// UC1 (pages + API) requires a signed-in user too: several /api/uc1 routes
// write to the DB and call paid third-party APIs (Google Solar/Maps, Claude
// Vision), so leaving them open is both a data and a cost exposure.
const isUc1Route = createRouteMatcher(["/uc1(.*)", "/api/uc1(.*)"]);

// Minimal replacement for Clerk's createRouteMatcher: exact segment or
// segment + subtree, which is all the two matchers above ever used.
function createRouteMatcher(patterns: string[]): (req: NextRequest) => boolean {
  const regexes = patterns.map((p) => new RegExp(`^${p.replace(/\(\.\*\)/g, "(.*)")}$`));
  return (req) => regexes.some((r) => r.test(req.nextUrl.pathname));
}

function uc1Gate(request: NextRequest, base: NextResponse) {
  if (UC1_ENABLED) return base;

  const { pathname } = request.nextUrl;
  if (!pathname.startsWith("/uc1") && !pathname.startsWith("/api/uc1")) {
    return base;
  }
  // UC1 JSON API → 404 (a redirect would be wrong for fetch callers).
  if (pathname.startsWith("/api/uc1")) {
    return NextResponse.json({ error: "UC1 is disabled" }, { status: 404 });
  }
  // UC1 pages → bounce to the landing page.
  return NextResponse.redirect(new URL("/", request.url));
}

async function withSupabase(request: NextRequest) {
  // The @supabase/ssr middleware pattern: mirror refreshed session cookies
  // onto both the forwarded request and the response.
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser() validates with the auth server and refreshes an expired session
  // (triggering the cookie writes above). Do not replace with getSession().
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && (isPlatformRoute(request) || isUc1Route(request))) {
    const signIn = new URL("/sign-in", request.url);
    signIn.searchParams.set("redirect_url", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(signIn);
  }
  return uc1Gate(request, response);
}

export function proxy(request: NextRequest, event: NextFetchEvent) {
  void event;
  if (authEnabled()) return withSupabase(request);

  // Fail CLOSED: without working auth, the platform routes only serve when
  // open demo mode was explicitly opted into (ALLOW_DEMO_MODE=true) — a
  // missing or mistyped auth env value must never silently open the platform.
  if ((isPlatformRoute(request) || isUc1Route(request)) && !demoModeAllowed()) {
    return new NextResponse(
      "Authentication is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY, or explicitly set ALLOW_DEMO_MODE=true for an open demo deployment.",
      { status: 503, headers: { "content-type": "text/plain" } },
    );
  }
  return uc1Gate(request, NextResponse.next());
}

export const config = {
  // Run on every route that carries a session: RootLayout resolves the viewer
  // (via getAuthEmail) on ALL pages, and this proxy is the only place expired
  // sessions get refreshed. So match everything except Next internals and
  // static assets. The sign-in redirect stays scoped to /app + /uc1 inside
  // the handler, and the UC1 page/API gating + fail-closed 503 also key off
  // the pathname there.
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpg|jpeg|gif|png|svg|ico|webp|woff2?|ttf|otf|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
