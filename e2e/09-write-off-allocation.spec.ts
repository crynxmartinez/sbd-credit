import { expect, test, type Page } from "@playwright/test";
import { ADMIN, EMPLOYEE, businessDaysAgo, alertWith, balanceText, drawer, newSession, openCustomer, requireCredentials, signIn, statusWith } from "./helpers";

/**
 * A write-off names the charges it covers. The form offers them, the review step lists them, the history says which were
 * covered, and a covered charge cannot be corrected until the write-off is reversed.
 */
const ORIGIN = process.env.E2E_ORIGIN ?? "http://127.0.0.1:3201";
const SUFFIX = Math.random().toString(36).slice(2, 7);
const NAME = `E2E Allocation Co ${SUFFIX}`;

test.beforeAll(requireCredentials);
test.describe.configure({ mode: "serial" });

let page: Page;
let customerId = "";

async function api(path: string, data?: object, method: "POST" | "GET" = "POST") {
  const response = method === "GET" ? await page.request.get(path) : await page.request.post(path, { headers: { Origin: ORIGIN }, data });
  return { status: response.status(), body: await response.json() };
}
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  page = await (await browser.newContext()).newPage();
  await signIn(page, ADMIN);
  const today = (await api("/api/customers", undefined, "GET")).body.data.asOf as string;
  customerId = (await api("/api/customers", { businessName: NAME, dateApplied: today })).body.data.id as string;
  const version = (await api(`/api/customers/${customerId}`, undefined, "GET")).body.data.customer.version as number;
  const approved = await api(`/api/customers/${customerId}/decision`, { action: "approve", version, creditLimitCents: 10_000_00, paymentTerms: "Net 30", creditStartDate: today });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  for (const [reference, cents, due] of [["INV-A", 100_00, 5], ["INV-B", 60_00, 25]] as const) {
    const made = await api(`/api/customers/${customerId}/ledger`, { type: "CHARGE", amountCents: cents, entryDate: today, dueDate: addDays(today, due), reference });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
  }
});
test.afterAll(async () => page.context().close());

const form = () => drawer(page).getByRole("form", { name: "Write off" });
const items = () => drawer(page).locator(".ledger-item");
const byLabel = (label: string) => items().filter({ has: page.locator(".ledger-label", { hasText: new RegExp(`^${label}$`) }) });
const writeOffRow = (text?: string) => (text ? byLabel("Write-off").filter({ hasText: text }) : byLabel("Write-off"));
const chargeRow = (reference: string) => byLabel("Charge").filter({ hasText: reference });

test("a write-off covers the oldest-due charge by default, and the review says so before anything is saved", async () => {
  await openCustomer(page, NAME);
  await expect.poll(() => balanceText(page)).toBe("$160.00");
  await drawer(page).getByRole("button", { name: "Write off" }).click();
  await expect(form().getByLabel("The oldest charges first")).toBeChecked();

  await form().getByLabel("Amount ($)").fill("120");
  await form().getByLabel("Reason (required)").fill("Customer closed, uncollectible");
  await form().getByRole("button", { name: "Review write-off" }).click();

  const covers = form().getByRole("list", { name: "Charges this covers" });
  await expect(covers.getByText("Covers INV-A: $100.00")).toBeVisible();
  await expect(covers.getByText("Covers INV-B: $20.00")).toBeVisible();
  await expect(balanceText(page)).resolves.toBe("$160.00"); // nothing saved yet

  await form().getByRole("button", { name: "Confirm write-off" }).click();
  await expect(statusWith(page, "Written off")).toBeVisible();
  await expect.poll(() => balanceText(page)).toBe("$40.00");
});

test("the history says which charges were covered, and a covered charge cannot be corrected", async () => {
  await expect(writeOffRow()).toContainText("covers INV-A ($100.00), INV-B ($20.00)");
  await expect(chargeRow("INV-A")).toContainText("Written off $100.00");
  await expect(chargeRow("INV-B")).toContainText("Written off $20.00");
  // Neither covered charge offers Void or Reverse, and the screen says why.
  await expect(drawer(page).getByRole("button", { name: /^(Void|Reverse) charge of \+\$100\.00/ })).toHaveCount(0);
  await expect(drawer(page).getByRole("button", { name: /^(Void|Reverse) charge of \+\$60\.00/ })).toHaveCount(0);
  await expect(chargeRow("INV-A")).toContainText("Reverse that write-off first");
});

test("the server refuses it too, with a message that names the write-off", async () => {
  const entries = (await api(`/api/customers/${customerId}`, undefined, "GET")).body.data.ledger as Array<{ id: string; reference: string | null; type: string }>;
  const chargeA = entries.find((entry) => entry.reference === "INV-A" && entry.type === "CHARGE")!;
  const refused = await api(`/api/customers/${customerId}/ledger/${chargeA.id}/void`, { reason: "Typo" });
  expect(refused.status).toBe(409);
  expect(refused.body.error.code).toBe("write_off_covers");
  expect(refused.body.error.message).toMatch(/write-off of \$120\.00/);
});

test("you can pick the charges instead; amounts that do not add up are refused before anything is sent", async () => {
  // Cover INV-B (which still has $40 open after the first write-off) by choice.
  await drawer(page).getByRole("button", { name: "Write off" }).click();
  await form().getByLabel("I will choose the charges").check();
  // INV-A is fully covered already: only INV-B is offered, with what is left open.
  await expect(form().getByText(/INV-A — /)).toHaveCount(0);
  await form().getByLabel(/INV-B — \$40\.00 open/).check();
  await expect(form().getByLabel("Amount to write off on INV-B")).toHaveValue("40.00");

  await form().getByLabel("Amount ($)").fill("25");
  await form().getByLabel("Reason (required)").fill("Part of it is uncollectible");
  await form().getByRole("button", { name: "Review write-off" }).click();
  await expect(alertWith(form(), "must add up to the write-off amount")).toBeVisible(); // 25 asked, 40 picked

  await form().getByLabel("Amount to write off on INV-B").fill("25");
  await form().getByRole("button", { name: "Review write-off" }).click();
  await expect(form().getByRole("list", { name: "Charges this covers" }).getByText("Covers INV-B: $25.00")).toBeVisible();
  await form().getByRole("button", { name: "Confirm write-off" }).click();
  await expect(statusWith(page, "Written off")).toBeVisible();
  await expect.poll(() => balanceText(page)).toBe("$15.00");
});

test("voiding this month's write-off frees its charges (a voided write-off leaves no trace); the other write-off still covers INV-B", async () => {
  await writeOffRow("$120.00").getByRole("button", { name: /^Void write-off of/ }).click();
  const voidForm = drawer(page).getByRole("form", { name: "Void entry" });
  await voidForm.getByLabel("Why is this being voided?").fill("Entered by mistake");
  await voidForm.getByRole("button", { name: "Void entry" }).click();
  await expect(statusWith(page, "Entry voided")).toBeVisible();

  await expect(chargeRow("INV-A")).not.toContainText("Written off");
  await expect(drawer(page).getByRole("button", { name: /^Void charge of \+\$100\.00/ })).toBeVisible();
  // INV-B is still covered by the second write-off, so it offers no correction.
  await expect(drawer(page).getByRole("button", { name: /^(Void|Reverse) charge of \+\$60\.00/ })).toHaveCount(0);
  await expect(chargeRow("INV-B")).toContainText("Written off $25.00");
});

test("an employee is never offered a write-off, and the server refuses one", async ({ browser }) => {
  const { context, page: employee } = await newSession(browser, EMPLOYEE);
  await openCustomer(employee, NAME);
  await expect(drawer(employee).getByRole("button", { name: "Write off" })).toHaveCount(0);
  const refused = await employee.request.post(`/api/customers/${customerId}/ledger`, {
    headers: { Origin: ORIGIN },
    data: { type: "WRITE_OFF", amountCents: 100, entryDate: businessDaysAgo(0), note: "Nope" },
  });
  expect(refused.status()).toBe(403);
  await context.close();
});
