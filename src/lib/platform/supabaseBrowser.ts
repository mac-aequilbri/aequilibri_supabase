// Browser-side Supabase Auth client (@supabase/ssr cookie sessions), for the
// sign-in/sign-up/reset forms and the nav sign-out button. Cookie-based, so
// the server (proxy + RSC) sees the session on the next request.

import { createBrowserClient } from "@supabase/ssr";

export function browserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
