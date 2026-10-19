import { expect, test } from "@playwright/test";
import { ADMIN, EMPLOYEE, newSession, requireCredentials } from "./helpers";

/**
 * Who may reach what, asked of the running server rather than read from its code: one row per route and kind of visitor. The
 * handler inventory (src/lib/route-inventory.test.ts) proves every route CHECKS for a person; this proves the answers.
 */
const ORIGIN = process.env.E2E_ORIGIN ?? "http://127.0.0.1:3201";
const SOME_ID = "00000000-0000-4000-8000-000000000000";

test.beforeAll(requireCredentials);

test.describe("an anonymous visitor", () => {
  for (const path of ["/api/customers", "/api/me", "/api/export/customers", "/api/export/ledger", `/api/customers/${SOME_ID}`, `/api/customers/${SOME_ID}/portal`]) {
    test(`GET ${path} is refused with 401`, async ({ request }) => {
      expect((await request.get(path)).status()).toBe(401);
    });
  }

  for (const path of ["/api/customers", `/api/customers/${SOME_ID}/decision`, `/api/customers/${SOME_ID}/ledger`, `/api/customers/${SOME_ID}/portal`]) {
    test(`POST ${path} is refused with 401`, async ({ request }) => {
      expect((await request.post(path, { headers: { Origin: ORIGIN }, data: {} })).status()).toBe(401);
    });
  }

  test("the staff pages send the visitor to sign in instead of showing anything", async ({ page }) => {
    for (const path of ["/", "/customers"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/login/);
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    }
  });

  test("the health check is public and says nothing about the database beyond up or down", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", checks: { database: "ok" } });
  });
});

test.describe("an employee", () => {
  test("may read and enter payments, and nothing that gives up or exports money", async ({ browser }) => {
    const { context, page } = await newSession(browser, EMPLOYEE);
    expect((await page.request.get("/api/customers")).status()).toBe(200);
    expect((await page.request.get("/api/me")).status()).toBe(200);
    for (const kind of ["customers", "ledger"]) expect((await page.request.get(`/api/export/${kind}`)).status(), kind).toBe(403);
    const reverse = await page.request.post(`/api/customers/${SOME_ID}/ledger/${SOME_ID}/reverse`, { headers: { Origin: ORIGIN }, data: { reason: "x" } });
    expect(reverse.status()).toBe(403);
    const portal = await page.request.post(`/api/customers/${SOME_ID}/portal`, { headers: { Origin: ORIGIN }, data: {} });
    expect([401, 403]).toContain(portal.status());
    await context.close();
  });
});

test.describe("an administrator", () => {
  test("may export, and an unknown customer is a 404, not a crash", async ({ browser }) => {
    const { context, page } = await newSession(browser, ADMIN);
    for (const kind of ["customers", "ledger"]) expect((await page.request.get(`/api/export/${kind}`)).status(), kind).toBe(200);
    expect((await page.request.get(`/api/customers/${SOME_ID}`)).status()).toBe(404);
    await context.close();
  });

  test("a staff session is not a customer session: the customer page does not show to staff", async ({ browser }) => {
    const { context, page } = await newSession(browser, ADMIN);
    await page.goto("/portal");
    await expect(page).not.toHaveURL(/\/portal/);
    await context.close();
  });
});
