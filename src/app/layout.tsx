import type { Metadata } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import { ClerkProvider, Show, UserButton } from "@clerk/nextjs";
import { clerkEnabled } from "@/lib/platform/authConfig";
import { isPlatformAdmin } from "@/lib/platform/org-context";
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

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const withAuth = clerkEnabled();
  // The UC1/UC3 cross-app switcher is an internal operator aid, not a
  // customer-facing control — only platform operators see it. (Demo mode with
  // no auth configured is operator-by-definition, so it stays visible there.)
  const showAppSwitcher = await isPlatformAdmin();
  const body = (
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
            {withAuth && (
              <div className="ml-auto shrink-0">
                <Show when="signed-in">
                  <UserButton />
                </Show>
              </div>
            )}
          </div>
        </nav>
        <div className="flex-1">{children}</div>
        <footer className="ae-footer">æquilibri — operations platform</footer>
      </body>
    </html>
  );
  return withAuth ? <ClerkProvider>{body}</ClerkProvider> : body;
}
