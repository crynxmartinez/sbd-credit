import type { NextConfig } from "next";

/** Headers every response carries. The Content-Security-Policy (it needs a per-request nonce) is set by src/proxy.ts. */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // Browsers ignore this over plain http (local development) and honour it once the app is served over https.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

/** Pages that show one customer's account, or carry an invitation, must never be stored by a browser or a shared cache. */
const privatePageHeaders = [
  { key: "Cache-Control", value: "no-store, max-age=0" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Matches /portal itself and everything under it.
      { source: "/portal/:path*", headers: privatePageHeaders },
      // No Referer at all from the invitation page, so the link can never be passed on by following something from it.
      { source: "/accept-invite", headers: [...privatePageHeaders, { key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/login", headers: privatePageHeaders },
    ];
  },
};

export default nextConfig;
