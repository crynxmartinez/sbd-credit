import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The customer portal and the staff app must stay separate doors. These checks read the source and fail if one starts
 * reaching into the other, or if a page that shows one customer's account could be cached and shown to someone else.
 * They are crude on purpose: a change that trips one has to be looked at by a person.
 */
const ROOT = join(__dirname, "..", "..");

function files(path: string): string[] {
  const full = join(ROOT, path);
  const info = statSync(full, { throwIfNoEntry: false });
  if (!info) return [];
  if (info.isFile()) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [join(full, entry.name)] : [],
  );
}

const read = (file: string): string => readFileSync(file, "utf8");
const name = (file: string): string => relative(ROOT, file).replaceAll("\\", "/");

const PORTAL_CODE = [
  ...files("src/app/portal"),
  ...files("src/app/accept-invite"),
  ...files("src/app/api/portal"),
  ...files("src/components/portal"),
  ...files("src/lib/server/services/portal.ts"),
  ...files("src/lib/server/auth/customer-session.ts"),
];

const STAFF_CODE = [
  ...files("src/app/api/customers"),
  ...files("src/app/api/export"),
  ...files("src/app/(app)"),
  ...files("src/lib/server/services/customers.ts"),
  ...files("src/lib/server/services/ledger.ts"),
  ...files("src/lib/server/services/exports.ts"),
];

function offenders(list: string[], pattern: RegExp): string[] {
  return list.filter((file) => pattern.test(read(file))).map(name);
}

describe("the portal and the staff app stay separate", () => {
  test("we are actually looking at the code (so these checks cannot pass by finding nothing)", () => {
    expect(PORTAL_CODE.length).toBeGreaterThan(8);
    expect(STAFF_CODE.length).toBeGreaterThan(8);
  });

  test("customer-facing code never imports a staff service", () => {
    expect(offenders(PORTAL_CODE, /services\/(customers|ledger|exports|portal-access)["']/)).toEqual([
      // The public invitation-accept route is the one place customer-side code uses the access service, and only to accept.
      "src/app/api/portal/accept/route.ts",
    ]);
  });

  test("customer-facing code never uses the staff permission check", () => {
    expect(offenders(PORTAL_CODE, /\brequireUser\b/)).toEqual([]);
  });

  test("staff code never reads a customer session", () => {
    expect(offenders(STAFF_CODE, /customer-session|requireCustomerUser|getCurrentCustomerUser/)).toEqual([
      // The staff layout only asks whether a customer is signed in, to send them to their own page.
      "src/app/(app)/layout.tsx",
    ]);
  });

  test("the only customer-side use of the staff session is the redirect that sends staff back to their own app", () => {
    expect(offenders(PORTAL_CODE, /getCurrentUser\b/)).toEqual(["src/app/portal/layout.tsx"]);
  });

  test("no portal code is cached, because a cached page could be shown to a different customer", () => {
    expect(offenders(PORTAL_CODE, /["']use cache["']|unstable_cache|revalidate\s*=\s*[1-9]|force-static/)).toEqual([]);
  });

  test("every customer-side page and handler is explicitly dynamic or a request handler", () => {
    const pages = PORTAL_CODE.filter((file) => /(page|layout)\.tsx$/.test(file) && /src\/app\//.test(name(file)));
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(read(page), name(page)).toMatch(/export const dynamic = "force-dynamic"/);
  });
});
