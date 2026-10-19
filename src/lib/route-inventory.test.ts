import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

/**
 * Every API route AND every handler in it, checked from its source with the TypeScript parser (not a text search): a new route, or a
 * new method added to an old file, that forgets the origin check or the sign-in check fails here instead of being found after it is
 * exploited. The checks are crude on purpose: a handler that trips one needs a person to decide whether the exception is real.
 */
const API = join(__dirname, "..", "app", "api");

function routes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routes(path);
    return entry.name === "route.ts" && statSync(path).isFile() ? [path] : [];
  });
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

interface Handler {
  route: string;
  method: string;
  /** The source text of this handler alone. */
  text: string;
}

/** Every exported HTTP handler in a route file, however it is written: a function, a const arrow, or `export { handler as POST }`. */
export function handlersIn(route: string, source: string): Handler[] {
  const file = ts.createSourceFile(route, source, ts.ScriptTarget.Latest, true);
  const declared = new Map<string, string>(); // local name -> its source text
  const handlers: Handler[] = [];

  for (const statement of file.statements) {
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declared.set(statement.name.text, statement.getText(file));
      if (exported && (HTTP_METHODS as readonly string[]).includes(statement.name.text)) handlers.push({ route, method: statement.name.text, text: statement.getText(file) });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        declared.set(declaration.name.text, statement.getText(file));
        if (exported && (HTTP_METHODS as readonly string[]).includes(declaration.name.text)) handlers.push({ route, method: declaration.name.text, text: statement.getText(file) });
      }
    }
  }
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (!(HTTP_METHODS as readonly string[]).includes(element.name.text)) continue;
        handlers.push({ route, method: element.name.text, text: declared.get((element.propertyName ?? element.name).text) ?? "" });
      }
    }
  }
  return handlers;
}

const name = (file: string) => relative(API, file).replaceAll("\\", "/");
const FILES = routes(API).map((file) => ({ file, name: name(file), source: readFileSync(file, "utf8") }));
const HANDLERS = FILES.flatMap(({ name: routeName, source }) => handlersIn(routeName, source));
const keyOf = (h: Handler) => `${h.method} ${h.route}`;

/** Routes anyone may call. Each one must be a deliberate decision, so adding one here is a code review. */
const PUBLIC_ROUTES: Readonly<Record<string, string>> = {
  "health/route.ts": "uptime monitors; says only whether the database is reachable",
  "auth/login/route.ts": "this IS sign-in; rate-limited per address and per account",
  "auth/logout/route.ts": "ends whatever session the browser holds; needs none",
  "portal/accept/route.ts": "a customer with an invitation link has no session yet; rate-limited, token-checked",
};

/**
 * The complete list of handlers. A handler that disappears, or appears, changes this list, so it is noticed and reviewed. (The other
 * checks below stop a new one being unprotected; this one stops it being invisible.)
 */
const EXPECTED_HANDLERS = [
  "POST auth/login/route.ts",
  "POST auth/logout/route.ts",
  "GET customers/[id]/route.ts",
  "PATCH customers/[id]/route.ts",
  "POST customers/[id]/decision/route.ts",
  "POST customers/[id]/ledger/route.ts",
  "POST customers/[id]/ledger/[entryId]/reverse/route.ts",
  "POST customers/[id]/ledger/[entryId]/void/route.ts",
  "GET customers/[id]/portal/route.ts",
  "POST customers/[id]/portal/route.ts",
  "PATCH customers/[id]/portal/[contactId]/route.ts",
  "POST customers/[id]/portal/[contactId]/reinvite/route.ts",
  "GET customers/route.ts",
  "POST customers/route.ts",
  "GET export/[kind]/route.ts",
  "GET health/route.ts",
  "GET me/route.ts",
  "POST portal/accept/route.ts",
];

describe("the API routes", () => {
  test("we found every handler there should be, and no unexpected one", () => {
    // Stated both ways on purpose: a dropped handler and a new one each need a person to look.
    const found = HANDLERS.map(keyOf).sort();
    const missing = EXPECTED_HANDLERS.filter((expected) => !found.includes(expected));
    const unexpected = found.filter((handler) => !EXPECTED_HANDLERS.includes(handler));
    expect({ missing, unexpected }).toEqual({ missing: [], unexpected: [] });
  });

  test("the parser sees handlers written every way (function, async function, const arrow, re-export)", () => {
    const sample = [
      "export function GET() { return 1; }",
      "export async function POST() { return 2; }",
      "export const PATCH = async () => 3;",
      "const remove = () => 4;",
      "export { remove as DELETE };",
      "export function helper() { return 5; }",
    ].join("\n");
    expect(handlersIn("sample.ts", sample).map((h) => h.method).sort()).toEqual(["DELETE", "GET", "PATCH", "POST"]);
  });

  test("EVERY handler that changes anything checks where the request came from", () => {
    const missing = HANDLERS.filter((h) => h.method !== "GET" && h.method !== "HEAD" && h.method !== "OPTIONS" && !h.text.includes("assertSameOrigin(")).map(keyOf);
    expect(missing).toEqual([]);
  });

  test("EVERY handler is either on the short public list, or requires a signed-in person", () => {
    const unprotected = HANDLERS.filter((h) => !(h.route in PUBLIC_ROUTES) && !/\brequireUser\(|\brequireCustomerUser\(/.test(h.text)).map(keyOf);
    expect(unprotected).toEqual([]);
  });

  test("the public list contains only routes that exist (no stale exceptions)", () => {
    const existing = new Set(FILES.map((r) => r.name));
    expect(Object.keys(PUBLIC_ROUTES).filter((route) => !existing.has(route))).toEqual([]);
  });

  test("a GET never changes anything", () => {
    // A GET that writes can be triggered from another site by an image tag; the origin check only protects POST and friends.
    const offenders = HANDLERS.filter((h) => h.method === "GET" && /\b(create|update|delete|record|void|reverse|decide|invite|reissue|accept)[A-Z]\w*\(/.test(h.text)).map(keyOf);
    expect(offenders).toEqual([]);
  });

  test("a comment that mentions the checks does not count as having them", () => {
    const sneaky = handlersIn("x.ts", "export function POST() {\n  // assertSameOrigin(request); requireUser();\n  return 1;\n}")[0]!;
    // The parser's text keeps comments, so strip them the way the checks above must: a real call is code, not a comment.
    const withoutComments = sneaky.text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments).not.toContain("assertSameOrigin(");
  });

  test("the routes that return customer data say it must not be stored", () => {
    // ok() and failure() set Cache-Control: no-store; a route that builds its own Response must set Cache-Control itself.
    const ownResponses = FILES.filter(({ source }) => /new Response\(/.test(source) && !/Cache-Control/.test(source)).map((r) => r.name);
    expect(ownResponses).toEqual([]);
  });
});
