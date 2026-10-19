import { expect, test } from "@playwright/test";
import { businessDaysAgo, ADMIN, EMPLOYEE, alertWith, drawer, newSession, openCustomer, requireCredentials, signIn, statusWith } from "./helpers";

const ORIGIN = process.env.E2E_ORIGIN ?? "http://127.0.0.1:3201";

test.beforeAll(requireCredentials);

test.describe("what an employee can and cannot do", () => {
  test("the controls an employee must not use are not offered", async ({ browser }) => {
    const { context, page } = await newSession(browser, EMPLOYEE);
    await openCustomer(page, "Midwest Fabrication LLC");

    await expect(drawer(page).getByRole("button", { name: "Record payment" })).toBeVisible();
    await expect(drawer(page).getByRole("button", { name: "Suspend credit" })).toHaveCount(0);
    await expect(drawer(page).getByRole("button", { name: "Adjustment" })).toHaveCount(0);
    await expect(drawer(page).getByRole("button", { name: /^Void / })).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /CSV/ })).toHaveCount(0);
    await context.close();
  });

  test("and the server refuses them even when asked directly", async ({ browser }) => {
    const { context, page } = await newSession(browser, EMPLOYEE);
    const list = await (await page.request.get("/api/customers")).json();
    const customer = list.data.customers.find((c: { businessName: string }) => c.businessName === "Midwest Fabrication LLC");

    const decision = await page.request.post(`/api/customers/${customer.id}/decision`, {
      headers: { Origin: ORIGIN },
      data: { action: "suspend", version: customer.version, reason: null },
    });
    expect(decision.status()).toBe(403);

    expect((await page.request.get("/api/export/customers")).status()).toBe(403);
    expect((await page.request.get("/api/export/ledger")).status()).toBe(403);

    const adjustment = await page.request.post(`/api/customers/${customer.id}/ledger`, {
      headers: { Origin: ORIGIN },
      data: { type: "ADJUSTMENT", amountCents: 100, entryDate: businessDaysAgo(0) },
    });
    // Refused for the right reason: the role, not (say) a date in a closed month, which also answers 403.
    expect(adjustment.status()).toBe(403);
    expect((await adjustment.json()).error.code).toBe("forbidden");
    await context.close();
  });

  test("a write from another website is blocked even with a valid session", async ({ browser }) => {
    const { context, page } = await newSession(browser, ADMIN);
    const response = await page.request.post("/api/customers", {
      headers: { Origin: "https://evil.example" },
      data: { businessName: "Forged Co", dateApplied: "2026-10-14" },
    });
    expect(response.status()).toBe(403);
    await context.close();
  });
});

test.describe("when things go wrong, the screen says so", () => {
  test("a failed load is an error with a Retry, never 'no customers yet'", async ({ browser }) => {
    const { context, page } = await newSession(browser, ADMIN);
    await page.route("**/api/customers", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ success: false, error: { code: "server_error", message: "Something went wrong." } }) }),
    );
    await page.goto("/customers");

    await expect(alertWith(page, "Couldn't load customers")).toBeVisible();
    await expect(page.getByText("No customers yet")).toHaveCount(0);

    await page.unroute("**/api/customers");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("button", { name: "Midwest Fabrication LLC", exact: true })).toBeVisible();
    await context.close();
  });

  test("a failed refresh keeps the last good data and says how old it is", async ({ browser }) => {
    const { context, page } = await newSession(browser, ADMIN);
    // A fake clock, so the 30-second background refresh can be made to happen now instead of waiting for it.
    await page.clock.install();
    await page.goto("/customers");
    await expect(page.getByRole("button", { name: "Midwest Fabrication LLC", exact: true })).toBeVisible();

    let refused = 0;
    await page.route("**/api/customers", (route) => {
      refused += 1;
      return route.abort("failed");
    });
    // The background refresh comes due (every 30 s) and the server cannot be reached.
    await page.clock.fastForward(31_000);

    // The refresh really failed, the person is TOLD so (with how old what they see is), and the last good data is still there.
    await expect.poll(() => refused).toBeGreaterThan(0);
    await expect(alertWith(page, /Couldn.t refresh customers\. Showing what was loaded at/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Midwest Fabrication LLC", exact: true })).toBeVisible();
    await context.close();
  });

  test("a customer that does not exist says so, instead of looking like a broken page", async ({ browser }) => {
    const { context, page } = await newSession(browser, ADMIN);
    await page.goto("/customers?c=does-not-exist");
    await expect(drawer(page).getByRole("heading", { name: "Customer not found" })).toBeVisible();
    await context.close();
  });

  test("an unknown address shows a not-found page, and the health check answers", async ({ page, request }) => {
    await page.goto("/no/such/page");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();

    const health = await request.get("/api/health");
    expect(health.status()).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", checks: { database: "ok" } });
  });
});

test.describe("two people editing the same customer", () => {
  test("the second save is told, can choose to overwrite, and then succeeds", async ({ browser }) => {
    const first = await newSession(browser, ADMIN);
    const second = await newSession(browser, ADMIN);
    const NAME = "Summit Roofing Co.";

    for (const { page } of [first, second]) {
      await openCustomer(page, NAME);
      await drawer(page).getByRole("button", { name: "Edit", exact: true }).click();
    }

    await first.page.getByRole("dialog", { name: "Edit credit application" }).getByLabel("Phone").fill("(555) 000-1111");
    await first.page.getByRole("button", { name: "Save changes" }).click();
    await expect(statusWith(first.page, "Application updated")).toBeVisible();

    const edit = second.page.getByRole("dialog", { name: "Edit credit application" });
    await edit.getByLabel("Internal notes").fill("Second editor's note");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(alertWith(edit, "Someone else changed this customer")).toBeVisible();

    // Saving again keeps their version, against the newest copy: it does not fail the same way twice.
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(statusWith(second.page, "Application updated")).toBeVisible();

    await first.context.close();
    await second.context.close();
  });
});

test.describe("the CSV export cannot be turned into an attack", () => {
  test("text that looks like a spreadsheet formula is defused", async ({ browser }) => {
    const { context, page } = await newSession(browser, ADMIN);
    const created = await page.request.post("/api/customers", {
      headers: { Origin: ORIGIN },
      data: { businessName: '=HYPERLINK("https://evil.example","click")', dateApplied: "2026-10-14" },
    });
    expect(created.status()).toBe(201);

    const csv = await page.request.get("/api/export/customers");
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    const body = await csv.text();
    expect(body.split("\r\n")[0]).toContain("Business,Contact");
    expect(body).toContain("'=HYPERLINK(");
    expect(body).not.toMatch(/(^|\r\n),?=HYPERLINK/);
    await context.close();
  });
});

// kept so this file can be run on its own against a signed-in admin
test("the dashboard loads for an admin", async ({ page }) => {
  await signIn(page, ADMIN);
  await expect(page.getByText("Needs attention").first()).toBeVisible();
});
