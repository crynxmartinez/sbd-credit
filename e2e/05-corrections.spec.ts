import { expect, test, type Page } from "@playwright/test";
import { ADMIN, EMPLOYEE, alertWith, balanceText, drawer, newSession, openCustomer, requireCredentials, signIn, statusWith } from "./helpers";

const ORIGIN = process.env.E2E_ORIGIN ?? "http://127.0.0.1:3201";
const NAME = "E2E Corrections Co";

test.beforeAll(requireCredentials);
// Each step builds on the last: seed an account, reverse an old charge, void a new one, write off what is left.
test.describe.configure({ mode: "serial" });

let page: Page;
let customerId = "";
let oldChargeId = "";

/** A date well inside a previous month, whatever today is: no month is longer than 31 days. */
function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * The business day, as the SERVER sees it. The browser's own date can be a day ahead of the books (in the evening in the
 * US, or just after midnight here), and an entry dated "tomorrow" does not count yet.
 */
async function serverToday(): Promise<string> {
  const response = await page.request.get("/api/customers");
  return (await response.json()).data.asOf as string;
}

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signIn(page, ADMIN);

  const post = async (path: string, data: object) => {
    const response = await page.request.post(path, { headers: { Origin: ORIGIN }, data });
    expect(response.status(), `${path}: ${await response.text()}`).toBeLessThan(300);
    return (await response.json()).data;
  };
  customerId = (await post("/api/customers", { businessName: NAME, dateApplied: daysAgo(60) })).id;
  await post(`/api/customers/${customerId}/decision`, {
    action: "approve",
    version: 1,
    creditLimitCents: 50_000_00,
    paymentTerms: "Net 30",
    creditStartDate: daysAgo(60),
  });
  oldChargeId = (await post(`/api/customers/${customerId}/ledger`, { type: "CHARGE", amountCents: 400_00, entryDate: daysAgo(40), reference: "INV-OLD" })).id;
  await post(`/api/customers/${customerId}/ledger`, { type: "CHARGE", amountCents: 100_00, entryDate: await serverToday(), reference: "INV-NEW" });
});
test.afterAll(async () => page.context().close());

const form = (name: string) => drawer(page).getByRole("form", { name });

test("an entry from a closed month offers Reverse, not Void; this month's offers Void", async () => {
  await openCustomer(page, NAME);
  await expect.poll(() => balanceText(page)).toBe("$500.00");

  await expect(drawer(page).getByRole("button", { name: /^Reverse charge of \+\$400\.00/ })).toBeVisible();
  await expect(drawer(page).getByRole("button", { name: /^Void charge of \+\$400\.00/ })).toHaveCount(0);
  await expect(drawer(page).getByRole("button", { name: /^Void charge of \+\$100\.00/ })).toBeVisible();
});

test("reversing needs a reason, adds an opposite entry dated today, and leaves the original in the history", async () => {
  await drawer(page).getByRole("button", { name: /^Reverse charge of \+\$400\.00/ }).click();
  await form("Reverse entry").getByRole("button", { name: "Reverse entry" }).click();
  await expect(alertWith(form("Reverse entry"), "Say why")).toBeVisible();

  await form("Reverse entry").getByLabel("Why is this being reversed?").fill("Billed to the wrong customer");
  await form("Reverse entry").getByRole("button", { name: "Reverse entry" }).click();
  await expect(statusWith(page, "Entry reversed")).toBeVisible();

  await expect.poll(() => balanceText(page)).toBe("$100.00");
  const items = drawer(page).locator(".ledger-item");
  await expect(items.filter({ hasText: "Reversal" })).toHaveCount(1);
  await expect(items.filter({ hasText: "Reversal" })).toContainText("−$400.00");
  await expect(items.filter({ hasText: "INV-OLD" }).filter({ hasText: "Reversed" })).toHaveCount(1);
  // A reversed entry and a reversal have no further actions: that would cancel it twice.
  await expect(drawer(page).getByRole("button", { name: /^(Reverse|Void) charge of \+\$400\.00/ })).toHaveCount(0);
  await expect(items.filter({ hasText: "Reversal" }).getByRole("button")).toHaveCount(0);

  await drawer(page).getByRole("tab", { name: "History" }).click();
  await expect(drawer(page).getByText(/Reversed charge of \$400\.00.*INV-OLD.*Billed to the wrong customer/)).toBeVisible();
  await drawer(page).getByRole("tab", { name: "Ledger" }).click();
});

test("the server refuses to void a closed month's entry even when asked directly, and says what to do", async () => {
  const created = await page.request.post(`/api/customers/${customerId}/ledger`, {
    headers: { Origin: ORIGIN },
    data: { type: "CHARGE", amountCents: 30_00, entryDate: daysAgo(45), reference: "INV-OLD-2" },
  });
  expect(created.status()).toBe(201);
  const entryId = (await created.json()).data.id;

  const response = await page.request.post(`/api/customers/${customerId}/ledger/${entryId}/void`, {
    headers: { Origin: ORIGIN },
    data: { reason: "Trying to rewrite history" },
  });
  expect(response.status()).toBe(409);
  expect((await response.json()).error.message).toContain("Reverse it instead");

  // Doing what it says works, and leaves the account where it was.
  const reversed = await page.request.post(`/api/customers/${customerId}/ledger/${entryId}/reverse`, {
    headers: { Origin: ORIGIN },
    data: { reason: "Entered by mistake" },
  });
  expect(reversed.status()).toBe(201);
});

test("a write-off cannot exceed what is owed, needs a reason, and is reported separately", async () => {
  await drawer(page).getByRole("button", { name: "Write off" }).click();
  await expect(form("Write off").getByText("Up to $100.00")).toBeVisible();

  await form("Write off").getByLabel("Amount ($)").fill("250");
  await form("Write off").getByLabel("Reason (required)").fill("Customer closed");
  await form("Write off").getByRole("button", { name: "Review write-off" }).click();
  await expect(alertWith(form("Write off"), "at most $100.00")).toBeVisible();

  await form("Write off").getByLabel("Amount ($)").fill("60");
  await form("Write off").getByLabel("Reason (required)").fill("");
  await form("Write off").getByRole("button", { name: "Review write-off" }).click();
  await expect(alertWith(form("Write off"), "Say why")).toBeVisible();

  // A valid write-off is not sent by the first press: it shows what will happen, and waits for a second.
  await form("Write off").getByLabel("Reason (required)").fill("Customer closed, uncollectible");
  await form("Write off").getByRole("button", { name: "Review write-off" }).click();
  await expect(form("Write off").getByText(/balance becomes/)).toContainText("$40.00");
  await expect(balanceText(page)).resolves.toBe("$100.00"); // nothing has changed yet
  await form("Write off").getByRole("button", { name: "Confirm write-off" }).click();
  await expect(statusWith(page, "Written off")).toBeVisible();

  await expect.poll(() => balanceText(page)).toBe("$40.00");
  await expect(drawer(page).getByText(/Written off:\s*\$60\.00/)).toBeVisible();
  await expect(drawer(page).locator(".ledger-item").filter({ has: page.locator(".ledger-label", { hasText: /^Write-off$/ }) })).toContainText("−$60.00");
});

test("the dashboard shows what has been written off", async () => {
  await page.keyboard.press("Escape");
  await page.goto("/");
  const card = page.locator(".stat-card").filter({ hasText: "Written off" });
  await expect(card).toBeVisible();
  const customers = await (await page.request.get("/api/customers")).json();
  const total = customers.data.customers.reduce((sum: number, c: { writtenOffCents: number }) => sum + c.writtenOffCents, 0);
  expect(total).toBeGreaterThanOrEqual(60_00);
});

test("an employee is not offered write-off, reverse or void, and the server refuses them", async ({ browser }) => {
  const { context, page: employee } = await newSession(browser, EMPLOYEE);
  await openCustomer(employee, NAME);
  await expect(drawer(employee).getByRole("button", { name: "Record payment" })).toBeVisible();
  await expect(drawer(employee).getByRole("button", { name: "Write off" })).toHaveCount(0);
  await expect(drawer(employee).getByRole("button", { name: /^(Reverse|Void) / })).toHaveCount(0);

  const reverse = await employee.request.post(`/api/customers/${customerId}/ledger/${oldChargeId}/reverse`, {
    headers: { Origin: ORIGIN },
    data: { reason: "Not allowed" },
  });
  expect(reverse.status()).toBe(403);
  const writeOff = await employee.request.post(`/api/customers/${customerId}/ledger`, {
    headers: { Origin: ORIGIN },
    data: { type: "WRITE_OFF", amountCents: 100, entryDate: daysAgo(0), note: "Not allowed" },
  });
  expect(writeOff.status()).toBe(403);
  await context.close();
});
