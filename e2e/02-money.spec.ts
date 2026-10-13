import { expect, test, type Page } from "@playwright/test";
import { ADMIN, alertWith, balanceText, drawer, openCustomer, requireCredentials, signIn, statusWith } from "./helpers";

const NAME = "E2E Steel Fabrication LLC";

test.beforeAll(requireCredentials);
// These build on each other: create, approve, charge, pay, void.
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signIn(page, ADMIN);
});
test.afterAll(async () => page.context().close());

const form = (name: string) => drawer(page).getByRole("form", { name });

test("creating an application with a double click makes exactly one customer", async () => {
  await page.goto("/customers");
  await page.getByRole("button", { name: "New credit application" }).click();
  await page.getByLabel("Business name").fill(NAME);
  await page.getByLabel("Requested limit ($)").fill("5,000.50");
  await page.getByRole("button", { name: "Create application" }).dblclick();

  await expect(drawer(page).getByRole("heading", { name: NAME })).toBeVisible();
  await expect(drawer(page).getByText("$5,000.50")).toBeVisible();

  await page.keyboard.press("Escape");
  await page.getByRole("searchbox").fill(NAME);
  await expect(page.getByRole("button", { name: NAME, exact: true })).toHaveCount(1);
});

test("an admin approves it with a limit and terms", async () => {
  await openCustomer(page, NAME);
  await drawer(page).getByRole("button", { name: "Approve" }).click();
  await form("Approve application").getByLabel("Credit limit ($)").fill("2000");
  await form("Approve application").getByRole("button", { name: "Confirm approval" }).click();

  await expect(drawer(page).locator(".badge")).toHaveText("Approved");
  await expect(drawer(page).getByText("$2,000").first()).toBeVisible();
});

test("a charge and a payment give an exact balance, to the cent", async () => {
  await drawer(page).getByRole("button", { name: "Add charge" }).click();
  await form("Add charge").getByLabel("Amount ($)").fill("1,234.56");
  await form("Add charge").getByRole("button", { name: "Add charge" }).click();
  await expect.poll(() => balanceText(page)).toBe("$1,234.56");

  await drawer(page).getByRole("button", { name: "Record payment" }).click();
  await form("Record payment").getByLabel("Amount ($)").fill("200.34");
  await form("Record payment").getByRole("button", { name: "Record payment" }).click();
  await expect.poll(() => balanceText(page)).toBe("$1,034.22");
});

test("a payment whose reply was lost can be retried safely: it is recorded once", async () => {
  let intercepted = false;
  await page.route("**/api/customers/*/ledger", async (route) => {
    if (!intercepted && route.request().method() === "POST") {
      intercepted = true;
      await route.fetch(); // the server really does record it...
      await route.abort("failed"); // ...but the browser never hears back
      return;
    }
    await route.continue();
  });

  await drawer(page).getByRole("button", { name: "Record payment" }).click();
  await form("Record payment").getByLabel("Amount ($)").fill("100");
  await form("Record payment").getByRole("button", { name: "Record payment" }).click();

  // The person is told it may have gone through, and that trying again is safe.
  await expect(alertWith(form("Record payment"), "may or may not have been saved")).toBeVisible();
  await expect(alertWith(form("Record payment"), "nothing will be recorded twice")).toBeVisible();

  await form("Record payment").getByRole("button", { name: "Record payment" }).click();
  await expect(statusWith(page, "already recorded")).toBeVisible();

  await page.unroute("**/api/customers/*/ledger");
  await expect.poll(() => balanceText(page)).toBe("$934.22"); // 1,034.22 less ONE payment of 100.00
  await expect(drawer(page).locator(".ledger-item").filter({ hasText: "−$100.00" })).toHaveCount(1);
});

test("a charge past the limit still records, and warns", async () => {
  await drawer(page).getByRole("button", { name: "Add charge" }).click();
  await form("Add charge").getByLabel("Amount ($)").fill("1500");
  await form("Add charge").getByRole("button", { name: "Add charge" }).click();

  await expect(statusWith(page, "over its credit limit")).toBeVisible();
  await expect.poll(() => balanceText(page)).toBe("$2,434.22");
});

test("voiding needs a reason, takes the entry out of the balance, and is kept in the history", async () => {
  await drawer(page).getByRole("button", { name: /^Void charge of \+\$1,500\.00/ }).click();
  await form("Void entry").getByRole("button", { name: "Void entry" }).click();
  await expect(alertWith(form("Void entry"), "Say why")).toBeVisible();

  await form("Void entry").getByLabel("Why is this being voided?").fill("Billed to the wrong job");
  await form("Void entry").getByRole("button", { name: "Void entry" }).click();

  await expect.poll(() => balanceText(page)).toBe("$934.22");
  await expect(drawer(page).locator(".ledger-item.voided")).toHaveCount(1);
  await drawer(page).getByRole("tab", { name: "History" }).click();
  await expect(drawer(page).getByText(/Voided charge of \$1,500\.00.*Billed to the wrong job/)).toBeVisible();
});

test("the dashboard figures agree with the customer's own screen", async () => {
  await page.keyboard.press("Escape");
  await page.goto("/");
  await expect(page.getByText("Total outstanding balance")).toBeVisible();
  const customers = await (await page.request.get("/api/customers")).json();
  const mine = customers.data.customers.find((c: { businessName: string }) => c.businessName === NAME);
  expect(mine.balanceCents).toBe(93_422);
});
