import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, EMPLOYEE, alertWith, balanceText, drawer, newSession, openCustomer, requireCredentials, signIn, statusWith } from "./helpers";

const ORIGIN = process.env.E2E_ORIGIN ?? "http://127.0.0.1:3201";
const NAME = "E2E Fixes Co";
const DENIED = "E2E Denied Owes Co";

test.beforeAll(requireCredentials);
// Each step builds on the last.
test.describe.configure({ mode: "serial" });

let page: Page;
let customerId = "";
let deniedId = "";
let today = "";

async function api(path: string, data?: object, method: "POST" | "GET" = "POST") {
  const response = method === "GET" ? await page.request.get(path) : await page.request.post(path, { headers: { Origin: ORIGIN }, data });
  return { status: response.status(), body: await response.json() };
}

/** Moves a customer through the workflow with the version it is at right now. */
async function decide(id: string, body: object) {
  const current = (await api(`/api/customers/${id}`, undefined, "GET")).body.data.customer.version as number;
  const result = await api(`/api/customers/${id}/decision`, { ...body, version: current });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  page = await (await browser.newContext()).newPage();
  await signIn(page, ADMIN);
  today = (await api("/api/customers", undefined, "GET")).body.data.asOf;

  customerId = (await api("/api/customers", { businessName: NAME, dateApplied: today })).body.data.id;
  await decide(customerId, { action: "approve", creditLimitCents: 5_000_00, paymentTerms: "Net 30", creditStartDate: today });
  expect((await api(`/api/customers/${customerId}/ledger`, { type: "CHARGE", amountCents: 300_00, entryDate: today, reference: "INV-F1" })).status).toBe(201);

  // A customer who was denied (after a suspension and a reopening) but still owes money.
  deniedId = (await api("/api/customers", { businessName: DENIED, dateApplied: today })).body.data.id;
  await decide(deniedId, { action: "approve", creditLimitCents: 2_000_00, paymentTerms: "Net 30", creditStartDate: today });
  expect((await api(`/api/customers/${deniedId}/ledger`, { type: "CHARGE", amountCents: 250_00, entryDate: today, reference: "INV-D1" })).status).toBe(201);
  await decide(deniedId, { action: "suspend", reason: null });
  await decide(deniedId, { action: "reopen" });
  await decide(deniedId, { action: "deny", reason: null });
});
test.afterAll(async () => page.context().close());

const form = (name: string) => drawer(page).getByRole("form", { name });

test("staff can record a payment for a denied customer who still owes money (the screen used to hide the button)", async () => {
  await openCustomer(page, DENIED);
  await expect(drawer(page).locator(".badge")).toHaveText("Denied");
  await expect.poll(() => balanceText(page)).toBe("$250.00");

  await drawer(page).getByRole("button", { name: "Record payment" }).click();
  await form("Record payment").getByLabel("Amount ($)").fill("100");
  await form("Record payment").getByRole("button", { name: "Record payment" }).click();
  await expect.poll(() => balanceText(page)).toBe("$150.00");
  // A denied account cannot be given NEW credit.
  await expect(drawer(page).getByRole("button", { name: "Add charge" })).toHaveCount(0);
});

test("the browser's Back button closes the customer drawer instead of leaving the page", async () => {
  await page.goto("/customers");
  await page.getByRole("button", { name: NAME, exact: true }).click();
  await expect(drawer(page)).toBeVisible();
  await expect(page).toHaveURL(/[?&]c=/);

  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/customers$/);
});

test("while a drawer is open the page behind it is inert: nothing in it can be reached", async () => {
  await openCustomer(page, NAME);
  await expect(page.locator(".app")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.locator(".app")).not.toHaveAttribute("inert", "");
});

test("an adjustment is entered as a positive amount with an explicit direction (a phone keyboard has no minus key)", async () => {
  await openCustomer(page, NAME);
  await drawer(page).getByRole("button", { name: "Adjustment", exact: true }).click();
  await expect(form("Post adjustment").getByLabel("Reduce what is owed")).toBeChecked();
  await form("Post adjustment").getByLabel("Amount ($)").fill("50");
  await form("Post adjustment").getByRole("button", { name: "Post adjustment" }).click();
  await expect.poll(() => balanceText(page)).toBe("$250.00");

  await drawer(page).getByRole("button", { name: "Adjustment", exact: true }).click();
  await form("Post adjustment").getByLabel("Increase what is owed").check();
  await form("Post adjustment").getByLabel("Amount ($)").fill("20");
  await form("Post adjustment").getByRole("button", { name: "Post adjustment" }).click();
  await expect.poll(() => balanceText(page)).toBe("$270.00");
});

test("a date far in the future is caught with a clear message before anything is sent", async () => {
  await drawer(page).getByRole("button", { name: "Add charge" }).click();
  await form("Add charge").getByLabel("Amount ($)").fill("10");
  await form("Add charge").getByLabel("Date", { exact: true }).fill("2099-01-01");
  await form("Add charge").getByRole("button", { name: "Add charge" }).click();
  await expect(alertWith(form("Add charge"), "more than 90 days ahead")).toBeVisible();
  await form("Add charge").getByRole("button", { name: "Cancel" }).click();
});

test("closing with a form open asks first, and 'Cancel' keeps the typing", async () => {
  await drawer(page).getByRole("button", { name: "Record payment" }).click();
  await form("Record payment").getByLabel("Amount ($)").fill("77");

  let asked = "";
  page.once("dialog", async (dialog) => {
    asked = dialog.message();
    await dialog.dismiss(); // "Cancel": stay
  });
  await page.keyboard.press("Escape");
  await expect.poll(() => asked).toMatch(/form/i);
  await expect(drawer(page)).toBeVisible();
  await expect(form("Record payment").getByLabel("Amount ($)")).toHaveValue("77");

  page.once("dialog", (dialog) => void dialog.accept()); // "OK": discard
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
});

test("a half-filled application asks before it is thrown away", async () => {
  await page.goto("/customers");
  await page.getByRole("button", { name: "New credit application" }).click();
  await page.getByLabel("Business name").fill("Typed But Not Saved Co");

  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Business name")).toHaveValue("Typed But Not Saved Co");

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("an employee's date picker starts at the first of this month, and the server refuses a closed month even if asked directly", async ({ browser }) => {
  const { context, page: employee } = await newSession(browser, EMPLOYEE);
  await openCustomer(employee, NAME);
  await drawer(employee).getByRole("button", { name: "Record payment" }).click();
  const date = drawer(employee).getByRole("form", { name: "Record payment" }).getByLabel("Date", { exact: true });
  await expect(date).toHaveAttribute("min", /^\d{4}-\d{2}-01$/);
  await expect(date).toHaveAttribute("max", /^\d{4}-\d{2}-\d{2}$/);

  const response = await employee.request.post(`/api/customers/${customerId}/ledger`, {
    headers: { Origin: ORIGIN },
    data: { type: "PAYMENT", amountCents: 100, entryDate: "2020-01-15" },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).error.code).toBe("closed_month_admin_only");
  await context.close();

  // An admin's picker has no lower limit.
  await openCustomer(page, NAME);
  await drawer(page).getByRole("button", { name: "Record payment" }).click();
  await expect(form("Record payment").getByLabel("Date", { exact: true })).not.toHaveAttribute("min", /.*/);
  await form("Record payment").getByRole("button", { name: "Cancel" }).click();
});

test("a confirmation message can be dismissed, and an error message stays until it is", async () => {
  await drawer(page).getByRole("button", { name: "Record payment" }).click();
  await form("Record payment").getByLabel("Amount ($)").fill("1");
  await form("Record payment").getByRole("button", { name: "Record payment" }).click();
  const confirmation = statusWith(page, "Payment recorded");
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Dismiss message" }).click();
  await expect(confirmation).toHaveCount(0);

  await page.keyboard.press("Escape");
  await page.goto("/customers");
  await page.route("**/api/export/customers", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ success: false, error: { code: "server_error", message: "The export failed on the server." } }) }),
  );
  await page.getByRole("button", { name: "Customers CSV" }).click();
  const failure = alertWith(page, "The export failed on the server.");
  await expect(failure).toBeVisible();
  // An error does not fade by itself: it is still there after longer than a confirmation lasts (6 s). Held with a polling check,
  // not a fixed sleep, so a slow machine neither passes by accident nor fails by timing.
  const started = Date.now();
  await expect.poll(async () => (await failure.isVisible()) && Date.now() - started, { timeout: 15_000, intervals: [500] }).toBeGreaterThan(7_000);
  await failure.getByRole("button", { name: "Dismiss message" }).click();
  await expect(failure).toHaveCount(0);
});

test("a CSV download that works actually saves a file", async () => {
  await page.unroute("**/api/export/customers");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Customers CSV" }).click();
  expect((await download).suggestedFilename()).toBe("customers.csv");
});

test("the dashboard and customers pages have their own titles", async () => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Dashboard/);
  await page.goto("/customers");
  await expect(page).toHaveTitle(/Customers/);
});

test("the open drawer with a write-off under review has no serious accessibility problems, in light and dark", async () => {
  await openCustomer(page, NAME);
  await drawer(page).getByRole("button", { name: "Write off" }).click();
  await form("Write off").getByLabel("Amount ($)").fill("10");
  await form("Write off").getByLabel("Reason (required)").fill("Customer closed, uncollectible");
  await form("Write off").getByRole("button", { name: "Review write-off" }).click();
  await expect(form("Write off").getByText(/balance becomes/)).toBeVisible();

  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`);
    expect(serious, `theme: ${theme}`).toEqual([]);
  }
  await form("Write off").getByRole("button", { name: "Cancel" }).click();
});

test("on a phone the customer list is cards, with no sideways scrolling, and a card opens the customer", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const phone = await context.newPage();
  await signIn(phone, ADMIN);
  await phone.goto("/customers");

  const cards = phone.getByRole("list", { name: "All customers" });
  await expect(cards).toBeVisible();
  await expect(phone.locator(".table-only")).toBeHidden();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await cards.getByRole("button", { name: new RegExp(NAME) }).click();
  await expect(phone.getByRole("dialog").getByRole("heading", { name: NAME })).toBeVisible();
  await context.close();
});
