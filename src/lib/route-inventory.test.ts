import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Every API route, checked from its source. A new route that forgets the origin check or the sign-in check is the kind of
 * mistake a person only notices after it is exploited, so it fails here instead. The checks are crude on purpose: a route
 * that trips one needs a person to decide whether the exception is real.
 */
const API = join(__dirname, "..", "app", "api");

function routes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routes(path);
    return entry.name === "route.ts" && statSync(path).isFile() ? [path] : [];
  });
}

const name = (file: string) => relative(API, file).replaceAll("\\", "/");
const ALL = routes(API).map((file) => ({ file, name: name(file), source: readFileSync(file, "utf8") }));
const methodsOf = (source: string) => [...source.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!);

/** Routes anyone may call. Each one must be a deliberate decision, so adding one here is a code review. */
const PUBLIC_ROUTES: Readonly<Record<string, string>> = {
  "health/route.ts": "uptime monitors; says only whether the database is reachable",
  "auth/login/route.ts": "this IS sign-in; rate-limited per address and per account",
  "auth/logout/route.ts": "ends whatever session the browser holds; needs none",
  "portal/accept/route.ts": "a customer with an invitation link has no session yet; rate-limited, token-checked",
};

describe("the API routes", () => {
  test("we found them (so these checks cannot pass by finding nothing)", () => {
    expect(ALL.length).toBeGreaterThanOrEqual(12);
  });

  test("every route that changes anything checks where the request came from", () => {
    const missing = ALL.filter(({ source }) => methodsOf(source).some((method) => method !== "GET") && !source.includes("assertSameOrigin(")).map((r) => r.name);
    expect(missing).toEqual([]);
  });

  test("every route is either on the short public list, or requires a signed-in person", () => {
    const unprotected = ALL.filter(({ name: routeName, source }) => !(routeName in PUBLIC_ROUTES) && !/\brequireUser\(|\brequireCustomerUser\(/.test(source)).map((r) => r.name);
    expect(unprotected).toEqual([]);
  });

  test("the public list contains only routes that exist (no stale exceptions)", () => {
    const existing = new Set(ALL.map((r) => r.name));
    expect(Object.keys(PUBLIC_ROUTES).filter((route) => !existing.has(route))).toEqual([]);
  });

  test("a GET never changes anything", () => {
    // A GET that writes can be triggered from another site by an image tag; the origin check only protects POST and friends.
    const offenders = ALL.filter(({ source }) => {
      const get = /export (?:async )?function GET[\s\S]*?(?=export (?:async )?function|$)/.exec(source)?.[0] ?? "";
      return /\b(create|update|delete|record|void|reverse|decide|invite|reissue|accept)[A-Z]\w*\(/.test(get);
    }).map((r) => r.name);
    expect(offenders).toEqual([]);
  });

  test("the routes that return customer data say it must not be stored", () => {
    // ok() and failure() set Cache-Control: no-store; a route that builds its own Response must set it itself.
    const ownResponses = ALL.filter(({ source }) => /new Response\(/.test(source) && !/Cache-Control/.test(source)).map((r) => r.name);
    expect(ownResponses).toEqual([]);
  });
});
