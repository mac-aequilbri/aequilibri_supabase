import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // AWS plan B2: emit .next/standalone (server.js + traced node_modules) so
  // the Docker runtime layer is the traced output, not the full install.
  // Inert for `next dev` and for Render-era `next start`.
  output: "standalone",

  // Native modules must not be bundled — load them from node_modules at runtime.
  serverExternalPackages: ["@napi-rs/canvas", "geotiff"],

  // Dev only (ignored in prod builds): the dev server binds to :: and is
  // browsed via http://[::1]:3000, which Next treats as a foreign origin and
  // blocks from fetching dev resources (HMR, RSC payloads on client navs).
  allowedDevOrigins: ["[::1]"],

  // Defense-in-depth for the BIMx embed: restrict which origins these pages
  // may frame. This backstops the graphisoft.com URL allowlist in
  // src/lib/platform/bimx.ts — even a stored bad URL cannot be framed. Scoped
  // to the routes that render BimxViewer (legacy /uc3 until cutover, platform
  // /app, public /portal) so UC1 (Google Maps) is unaffected. Only `frame-src`
  // is set, so no other resource type is constrained.
  async headers() {
    const bimxCsp = {
      key: "Content-Security-Policy",
      value: "frame-src 'self' https://graphisoft.com https://*.graphisoft.com",
    };
    // Baseline hardening on every route. HSTS is safe because Render serves
    // HTTPS-only; SAMEORIGIN (not DENY) keeps same-site framing possible while
    // blocking clickjacking; the Permissions-Policy disables powerful features
    // nothing in the app uses (verified: no geolocation/camera/mic access).
    const baseline = [
      { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ];
    return [
      { source: "/:path*", headers: baseline },
      { source: "/app/:path*", headers: [bimxCsp] },
      { source: "/portal/:path*", headers: [bimxCsp] },
    ];
  },

  // Cutover: UC2/UC3 were rebuilt onto the shared platform core under
  // /app/[org]. Old URLs redirect — UC2 was the single Dulong Downs
  // instance (1:1 path mapping); UC3 was cookie-tenant based, so its deep
  // links land on the org picker. Old public portal links keep working.
  async redirects() {
    return [
      { source: "/uc2/chat", destination: "/app/dulong-downs/assistant", permanent: false },
      { source: "/uc2/change-log", destination: "/app/dulong-downs/exec-log", permanent: false },
      { source: "/uc2", destination: "/app/dulong-downs", permanent: false },
      { source: "/uc2/:path*", destination: "/app/dulong-downs/:path*", permanent: false },
      { source: "/uc3/portal/public/:token", destination: "/portal/:token", permanent: false },
      { source: "/uc3", destination: "/app", permanent: false },
      { source: "/uc3/:path*", destination: "/app", permanent: false },
    ];
  },
};

export default nextConfig;
