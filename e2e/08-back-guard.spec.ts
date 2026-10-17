import { expect, test, type Dialog, type Page } from "@playwright/test";
import { ADMIN, drawer, openCustomer, requireCredentials, signIn } from "./helpers";

/**
 * The browser's Back button is a way out of a screen, like Close and Escape, and must ask before it throws away typing or an
 * invitation link that is shown only once.
 */
const ORIGIN = process.env.E2E_ORIGIN ?? "http://127.0.0.1:3201";
const SUFFIX = Math.random().toString(36).slice(2, 8);
const NAME = `E2E Back Guard Co ${SUFFIX}`;

test.beforeAll(requireCredentials);
test.describe.configure({ mode: "serial" });

let page: Page;
let customerId = "";

async function api(path: string, data?: object, method: "POST" | "GET" = "POST") {
  const response = method === "GET" ? await page.request.get(path) : await page.request.post(path, { headers: { Origin: ORIGIN }, data });
  return { status: response.status(), body: await response.json() };
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  page = await (await browser.newContext()).newPage();
  await signIn(page, ADMIN);
  const today = (await api("/api/customers", undefined, "GET")).body.data.asOf as string;
  const id = (await api("/api/customers", { businessName: NAME, dateApplied: today })).body.data.id as string;
  customerId = id;
  const version = (await api(`/api/customers/${id}`, undefined, "GET")).body.data.customer.version as number;
  const approved = await api(`/api/customers/${id}/decision`, { action: "approve", version, creditLimitCents: 5_000_00, paymentTerms: "Net 30", creditStartDate: today });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
});
test.afterAll(async () => page.context().close());

/** Answers the next confirmation box, recording what it said. */
function answerNext(accept: boolean): { message: () => string | null } {
  let said: string | null = null;
  page.once("dialog", (dialog: Dialog) => {
    said = dialog.message();
    void (accept ? dialog.accept() : dialog.dismiss());
  });
  return { message: () => said };
}

/** Collects any confirmation box that appears until stop() is called, and returns what they said. */
function watchDialogs(): () => string[] {
  const seen: string[] = [];
  const record = (dialog: Dialog) => {
    seen.push(dialog.message());
    void dialog.dismiss();
  };
  page.on("dialog", record);
  return () => {
    page.off("dialog", record);
    return seen;
  };
}

const form = (name: string) => drawer(page).getByRole("form", { name });
const goBack = () => page.evaluate(() => window.history.back());

test("Back with a half-filled form asks first; Cancel keeps the customer, the form and what was typed", async () => {
  await openCustomer(page, NAME);
  await drawer(page).getByRole("button", { name: "Record payment" }).click();
  await form("Record payment").getByLabel("Amount ($)").fill("42");

  const asked = answerNext(false);
  await goBack();
  await expect.poll(() => asked.message()).toMatch(/form open.*not been saved/i);

  await expect(drawer(page)).toBeVisible();
  await expect(page).toHaveURL(/[?&]c=/);
  await expect(form("Record payment").getByLabel("Amount ($)")).toHaveValue("42");
});

test("...and the Close button still works afterwards, and asks only once (history stayed consistent)", async () => {
  const asked = answerNext(true);
  await drawer(page).getByRole("button", { name: "Close customer details" }).click();
  await expect.poll(() => asked.message()).toMatch(/form open/i);
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/customers$/);
});

test("Back with a half-filled form, then OK, closes the customer and lands on the list", async () => {
  await openCustomer(page, NAME);
  await drawer(page).getByRole("button", { name: "Record payment" }).click();
  await form("Record payment").getByLabel("Amount ($)").fill("42");

  const asked = answerNext(true);
  await goBack();
  await expect.poll(() => asked.message()).toMatch(/form open/i);
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/customers$/);
  await expect(page.getByRole("button", { name: "New credit application" })).toBeVisible(); // the page works, not stuck half-way
});

test("Back with nothing typed closes the customer without asking", async () => {
  await openCustomer(page, NAME);
  const stop = watchDialogs();
  await goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/customers$/);
  expect(stop(), "no confirmation box should have appeared").toEqual([]);
});

test("Back while an invitation link is on screen asks, because the link cannot be shown again", async () => {
  await openCustomer(page, NAME);
  await drawer(page).getByRole("button", { name: "Add a person" }).click();
  const invite = form("Add a person");
  await invite.getByLabel("Name").fill("Dana Whitfield");
  await invite.getByLabel("Email").fill(`dana.${SUFFIX}@back-guard.example.com`);
  await invite.getByRole("button", { name: "Create invite link" }).click();
  const box = drawer(page).getByRole("group", { name: "Invitation link" });
  await expect(box).toBeVisible();

  const asked = answerNext(false);
  await goBack();
  await expect.poll(() => asked.message()).toMatch(/shown only once/i);
  await expect(box).toBeVisible(); // still there

  await box.getByRole("button", { name: "Done" }).click();
  const stop = watchDialogs();
  await goBack(); // nothing to lose any more
  await expect(drawer(page)).toHaveCount(0);
  expect(stop(), "no confirmation box should have appeared").toEqual([]);
});

test("a half-filled new application asks before Back leaves the page; Cancel keeps the page and the typing", async () => {
  await page.goto("/");
  await page.getByRole("link", { name: "Customers" }).first().click();
  await expect(page).toHaveURL(/\/customers$/);
  await page.getByRole("button", { name: "New credit application" }).click();
  await page.getByLabel("Business name").fill("Typed But Not Saved Co");

  const asked = answerNext(false);
  await goBack();
  await expect.poll(() => asked.message()).toMatch(/discard what you have entered/i);
  await expect(page).toHaveURL(/\/customers$/);
  await expect(page.getByLabel("Business name")).toHaveValue("Typed But Not Saved Co");

  const accepted = answerNext(true);
  await goBack();
  await expect.poll(() => accepted.message()).toMatch(/discard/i);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/); // it really did go Back to the dashboard
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});

test("an untouched application form lets Back through without asking", async () => {
  await page.goto("/");
  await page.getByRole("link", { name: "Customers" }).first().click();
  await page.getByRole("button", { name: "New credit application" }).click();
  await expect(page.getByLabel("Business name")).toBeVisible();
  const stop = watchDialogs();
  await goBack();
  await expect(page).toHaveURL(/\/$/);
  expect(stop(), "no confirmation box should have appeared").toEqual([]);
});

test("an edit form open over a customer asks ONCE on Back, and OK closes both", async () => {
  await openCustomer(page, NAME);
  await drawer(page).getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit credit application" }).getByLabel("Phone").fill("(555) 010-0000");

  let boxes = 0;
  page.on("dialog", () => {
    boxes += 1;
  });
  const asked = answerNext(true);
  await goBack();
  await expect.poll(() => asked.message()).toMatch(/discard/i);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/customers$/);
  expect(boxes).toBe(1);
  page.removeAllListeners("dialog");
});

test("a customer opened from a pasted link closes for good: Close with a form open asks once and does not bring the customer back", async () => {
  await page.goto(`/customers?c=${customerId}`); // a deep link: there is no history entry of ours beneath it
  await expect(drawer(page)).toBeVisible();
  await drawer(page).getByRole("button", { name: "Record payment" }).click();
  await form("Record payment").getByLabel("Amount ($)").fill("5");

  const asked = answerNext(true);
  await drawer(page).getByRole("button", { name: "Close customer details" }).click();
  await expect.poll(() => asked.message()).toMatch(/form open/i);
  await expect(drawer(page)).toHaveCount(0);
  await page.waitForTimeout(1_500); // long enough for a wrongly-reopened drawer to appear
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]c=/);
});
