import type { Metadata } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import { UserMenu } from "@/components/UserMenu";
import { authEnabled } from "@/lib/platform/authConfig";
import { getAuthEmail, isPlatformAdmin } from "@/lib/platform/org-context";
import "./globals.css";

// Vendored from @fontsource/montserrat 5.3.0 (latin subset). next/font/google
// fetches from fonts.gstatic.com at compile time, which is blocked on this
// network and is an external build dependency we don't want in a
// compliance-focused build anyway.
const montserrat = localFont({
  variable: "--font-montserrat",
  src: [
    { path: "./fonts/montserrat-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/montserrat-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/montserrat-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
});

export const metadata: Metadata = {
  title: "æquilibri",
  description: "æquilibri — AI-assisted operations platform",
};

// Never prerender: this layout renders the current session (user menu, admin
// nav), and a build-time render bakes a session-less demo-mode shell that
// client navigation then mixes with runtime-rendered segments (the Clerk
// provider crash of 2026-09-21). Rendering per-request keeps every segment
// on the same runtime env and the same session.
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const withAuth = authEnabled();
  const email = await getAuthEmail();
  // The UC1/UC3 cross-app switcher is an internal operator aid, not a
  // customer-facing control — only platform operators see it. (Demo mode with
  // no auth configured is operator-by-definition, so it stays visible there.)
  const showAppSwitcher = await isPlatformAdmin();
  return (
    <html lang="en" className={`${montserrat.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        <nav className="ae-navbar">
          <div className="px-4 sm:px-6 h-14 flex items-center gap-3 sm:gap-6 overflow-x-auto">
            <Link href="/" className="ae-brand shrink-0">
              æquilibri
            </Link>
            {showAppSwitcher && (
              <>
                <Link href="/uc1" className="text-sm text-[var(--ae-earth)] hover:text-[var(--ae-space)] whitespace-nowrap shrink-0">
                  Roofing
                </Link>
                <Link href="/app" className="text-sm text-[var(--ae-earth)] hover:text-[var(--ae-space)] whitespace-nowrap shrink-0">
                  MSME platform
                </Link>
              </>
            )}
            {withAuth && email && (
              <div className="ml-auto shrink-0">
                <UserMenu email={email} />
              </div>
            )}
          </div>
        </nav>
        <div className="flex-1">{children}</div>
        <footer className="ae-footer">æquilibri — operations platform</footer>
      </body>
    </html>
  );
}
