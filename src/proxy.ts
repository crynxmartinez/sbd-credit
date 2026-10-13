import { NextResponse, type NextRequest } from "next/server";

/**
 * Content-Security-Policy with a fresh nonce for every page view.
 *
 * Scripts run only if they carry this request's nonce (or were loaded by a script that does), so an injected
 * <script> in customer-supplied text cannot execute even if some future change forgot to escape it.
 * Pages are all dynamic, which a per-request nonce requires.
 *
 * style-src-attr allows the inline style="" attributes the interface uses for sizes and bar widths. It does not allow
 * injected <style> blocks, which stay blocked.
 */
export function buildCsp(nonce: string, development: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    // The dev server's hot reload talks over a websocket.
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  // Upgrading to https would break http://127.0.0.1 during development.
  if (!development) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, process.env.NODE_ENV === "development");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Lets a server component send a signed-out visitor to sign in and then back to exactly where they were headed.
  requestHeaders.set("x-pathname", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: API responses are JSON and static assets need no policy.
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
