import { describe, expect, test } from "vitest";
import nextConfig from "../next.config";
import { config as proxyConfig } from "./proxy";

/**
 * The response headers are the app's outer wall: framing, sniffing, transport and caching. They live in config, where nothing
 * exercises them in a normal test run, so they are asserted here from the configuration itself.
 */
type Rule = { source: string; headers: Array<{ key: string; value: string }> };
const rules = async (): Promise<Rule[]> => (await nextConfig.headers!()) as Rule[];

/** What a browser would end up with for a path: later, more specific rules override earlier ones for the same key. */
async function headersFor(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const rule of await rules()) {
    const pattern = new RegExp(`^${rule.source.replace(/:path\*/g, ".*").replace(/\//g, "\\/")}$`);
    if (pattern.test(path) || (rule.source.endsWith("/:path*") && path === rule.source.replace("/:path*", ""))) {
      for (const header of rule.headers) result[header.key] = header.value;
    }
  }
  return result;
}

describe("response headers", () => {
  test("every page forbids framing, sniffing, a referrer beyond the origin and device sensors, and asks for https for a year", async () => {
    const h = await headersFor("/customers");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toMatch(/camera=\(\).*microphone=\(\).*geolocation=\(\)/);
    expect(h["Strict-Transport-Security"]).toMatch(/max-age=31536000/);
    expect(h["Strict-Transport-Security"]).toMatch(/includeSubDomains/);
  });

  test("the customer pages and the sign-in page are never stored, and not indexed", async () => {
    for (const path of ["/portal", "/portal/anything", "/login", "/accept-invite"]) {
      const h = await headersFor(path);
      expect(h["Cache-Control"], path).toMatch(/no-store/);
      expect(h["X-Robots-Tag"], path).toMatch(/noindex/);
    }
  });

  test("the invitation page sends NO referrer at all, so its link can never be passed on", async () => {
    expect((await headersFor("/accept-invite"))["Referrer-Policy"]).toBe("no-referrer");
    expect((await headersFor("/customers"))["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  test("the framework does not announce itself", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

describe("which requests the policy proxy runs on", () => {
  const matcher = (proxyConfig.matcher as Array<{ source: string; missing?: unknown }>)[0]!;
  const matches = (path: string) => new RegExp(`^${matcher.source.replace(/\(\.\*\)/g, "(.*)")}$`.replace("/((?!", "/((?!")).test(path);

  test("pages get the Content-Security-Policy; API responses and static assets do not (they are JSON and files)", () => {
    for (const page of ["/", "/login", "/customers", "/portal", "/accept-invite"]) expect(matches(page), page).toBe(true);
    for (const other of ["/api/customers", "/api/health", "/_next/static/chunk.js", "/_next/image", "/favicon.ico"]) expect(matches(other), other).toBe(false);
  });

  test("a prefetch request is left alone (it renders nothing that needs a nonce)", () => {
    expect(JSON.stringify(matcher.missing)).toMatch(/next-router-prefetch/);
  });
});
