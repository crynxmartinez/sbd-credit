import { describe, expect, test } from "vitest";
import { buildCsp } from "./proxy";

const directive = (csp: string, name: string) => csp.split("; ").find((part) => part.startsWith(`${name} `)) ?? "";

describe("buildCsp", () => {
  const production = buildCsp("abc123", false);

  test("scripts need this request's nonce and nothing inline is allowed", () => {
    const scripts = directive(production, "script-src");
    expect(scripts).toContain("'nonce-abc123'");
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });

  test("injected style blocks stay blocked; only inline style attributes are allowed", () => {
    expect(directive(production, "style-src")).not.toContain("'unsafe-inline'");
    expect(directive(production, "style-src-attr")).toContain("'unsafe-inline'");
  });

  test("closes the usual injection routes", () => {
    expect(production).toContain("object-src 'none'");
    expect(production).toContain("base-uri 'self'");
    expect(production).toContain("form-action 'self'");
    expect(production).toContain("frame-ancestors 'none'");
    expect(directive(production, "default-src")).toBe("default-src 'self'");
  });

  test("nothing is loaded from another site: fonts, styles and connections are all the site's own", () => {
    expect(directive(production, "font-src")).toBe("font-src 'self'");
    expect(directive(production, "style-src")).not.toContain("https:");
    expect(directive(production, "connect-src")).toBe("connect-src 'self'");
    expect(directive(production, "img-src")).toBe("img-src 'self' data:");
  });

  test("production upgrades insecure requests; development does not and allows hot reload", () => {
    expect(production).toContain("upgrade-insecure-requests");
    const development = buildCsp("abc123", true);
    expect(development).not.toContain("upgrade-insecure-requests");
    expect(directive(development, "script-src")).toContain("'unsafe-eval'");
    expect(directive(development, "connect-src")).toContain("ws:");
  });
});

describe("proxy()", () => {
  test("tells server components which page was asked for, so sign-in can return there", async () => {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("./proxy");
    const response = proxy(new NextRequest("http://app.example/customers?status=approved&c=abc"));
    expect(response.headers.get("x-middleware-request-x-pathname")).toBe("/customers?status=approved&c=abc");
    expect(response.headers.get("content-security-policy")).toMatch(/script-src[^;]*'nonce-/);
  });

  test("gives every request its own nonce", async () => {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("./proxy");
    const nonce = (policy: string | null) => /'nonce-([^']+)'/.exec(policy ?? "")?.[1];
    const a = nonce(proxy(new NextRequest("http://app.example/")).headers.get("content-security-policy"));
    const b = nonce(proxy(new NextRequest("http://app.example/")).headers.get("content-security-policy"));
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});
