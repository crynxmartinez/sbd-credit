import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { businessDaysAgo, ADMIN, EMPLOYEE, alertWith, drawer, newSession, openCustomer, requireCredentials, signIn } from "./helpers";

const ORIGIN = process.env.E2E_ORIGIN ?? "http://127.0.0.1:3201";
const NAME = "E2E Portal Co";
const OTHER = "E2E Other Portal Co";
const SUFFIX = randomBytes(4).toString("hex");
const EMAIL = `dana.${SUFFIX}@portal.example.com`;
const OTHER_EMAIL = `omar.${SUFFIX}@portal.example.com`;
const PASSWORD = `Pw-${randomBytes(9).toString("base64url")}`;
const OTHER_PASSWORD = `Pw-${randomBytes(9).toString("base64url")}`;

test.beforeAll(requireCredentials);
// Each step builds on the last: set up two customers, invite, accept, sign in, isolate, turn off.
test.describe.configure({ mode: "serial" });

let admin: Page;
let customerId = "";
let otherId = "";
let inviteLink = "";

const daysAgo = businessDaysAgo;

async function post(page: Page, path: string, data: object): Promise<{ status: number; body: { data?: Record<string, unknown>; error?: { message: string } } }> {
  const response = await page.request.post(path, { headers: { Origin: ORIGIN }, data });
  return { status: response.status(), body: await response.json() };
}

async function approvedCustomerWithCharge(page: Page, name: string, reference: string, note: string): Promise<string> {
  const created = await post(page, "/api/customers", { businessName: name, dateApplied: daysAgo(30), notes: `INTERNAL-NOTE-${name}` });
  const id = created.body.data?.id as string;
  expect((await post(page, `/api/customers/${id}/decision`, { action: "approve", version: 1, creditLimitCents: 10_000_00, paymentTerms: "Net 30", creditStartDate: daysAgo(30) })).status).toBe(200);
  expect((await post(page, `/api/customers/${id}/ledger`, { type: "CHARGE", amountCents: 400_00, entryDate: daysAgo(3), reference, note })).status).toBe(201);
  return id;
}

/** Offers access through the admin API and walks the contact to a working password. */
async function onboard(page: Page, id: string, email: string, password: string): Promise<string> {
  const invited = await post(page, `/api/customers/${id}/portal`, { name: "Dana Whitfield", email });
  expect(invited.status).toBe(201);
  const link = invited.body.data?.link as string;
  const token = new URL(link).hash.replace("#t=", "");
  expect((await post(page, "/api/portal/accept", { token, password })).status).toBe(200);
  return link;
}

async function newCustomerSession(browser: Browser, email: string, password: string): Promise<{ context: BrowserContext; page: Page }> {
  return newSession(browser, { username: email, password });
}

test.beforeAll(async ({ browser }) => {
  admin = await (await browser.newContext()).newPage();
  await signIn(admin, ADMIN);
  customerId = await approvedCustomerWithCharge(admin, NAME, "INV-PORTAL-MINE", "SECRET-ENTRY-NOTE-MINE");
  otherId = await approvedCustomerWithCharge(admin, OTHER, "INV-OTHER-ONLY", "SECRET-ENTRY-NOTE-OTHER");
});
test.afterAll(async () => admin.context().close());

test("an admin offers portal access from the customer, and gets a one-time link", async () => {
  await openCustomer(admin, NAME);
  const panel = drawer(admin).getByText("Customer portal").locator("..");
  await expect(panel).toBeVisible();
  await expect(drawer(admin).getByText("No one has access yet.")).toBeVisible();

  await drawer(admin).getByRole("button", { name: "Add a person" }).click();
  const form = drawer(admin).getByRole("form", { name: "Add a person" });
  await form.getByLabel("Name").fill("Dana Whitfield");
  await form.getByLabel("Email").fill(EMAIL);
  await form.getByRole("button", { name: "Create invite link" }).click();

  const box = drawer(admin).getByRole("group", { name: "Invitation link" });
  await expect(box).toBeVisible();
  await expect(box.getByText("It is shown only now")).toBeVisible();
  inviteLink = await box.getByRole("textbox", { name: /Invitation link/ }).inputValue();
  expect(inviteLink).toMatch(new RegExp(`^${ORIGIN.replaceAll(".", "\\.")}/accept-invite#t=[A-Za-z0-9_-]{43}$`));
  await expect(drawer(admin).getByText("Dana Whitfield").first()).toBeVisible();
  await expect(drawer(admin).getByText("Invited", { exact: true })).toBeVisible();

  // Done hides the link for good: there is no way to show it again.
  await box.getByRole("button", { name: "Done" }).click();
  await expect(box).toHaveCount(0);
  await drawer(admin).getByRole("button", { name: "Close customer details" }).click();
  await openCustomer(admin, NAME);
  await expect(drawer(admin).getByRole("textbox", { name: /Invitation link/ })).toHaveCount(0);
});

test("an employee is not offered portal access, and the server refuses it", async ({ browser }) => {
  const { context, page } = await newSession(browser, EMPLOYEE);
  await openCustomer(page, NAME);
  await expect(drawer(page).getByText("Customer portal")).toHaveCount(0);
  expect((await post(page, `/api/customers/${customerId}/portal`, { name: "Eve", email: `eve.${SUFFIX}@portal.example.com` })).status).toBe(403);
  expect((await page.request.get(`/api/customers/${customerId}/portal`)).status()).toBe(403);
  await context.close();
});

test("the invitation page keeps the secret out of the address, sets a password once, and the link cannot be used twice", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requestedUrls: string[] = [];
  page.on("request", (request) => requestedUrls.push(request.url()));

  await page.goto(inviteLink);
  await expect(page.getByRole("form", { name: "Set your password" })).toBeVisible();
  await expect(page).toHaveURL(`${ORIGIN}/accept-invite`); // the secret is gone from the address bar

  await page.getByLabel("New password").fill(PASSWORD);
  await page.getByLabel("Type it again").fill(`${PASSWORD}-different`);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(alertWith(page, "do not match")).toBeVisible();

  await page.getByLabel("New password").fill("short");
  await page.getByLabel("Type it again").fill("short");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(alertWith(page, "at least")).toBeVisible();

  await page.getByLabel("New password").fill(PASSWORD);
  await page.getByLabel("Type it again").fill(PASSWORD);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Your password is set")).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to sign in" })).toBeFocused();

  // The secret never appeared in any address the browser asked for.
  const token = new URL(inviteLink).hash.replace("#t=", "");
  expect(requestedUrls.filter((url) => url.includes(token))).toEqual([]);

  // Using the same link again says so, with the same words however it fails. (Going from this page to the same page with
  // only the "#" part changed would not reload it, so leave first.)
  await page.goto("/login");
  await page.goto(inviteLink);
  await page.getByLabel("New password").fill(`${PASSWORD}-2`);
  await page.getByLabel("Type it again").fill(`${PASSWORD}-2`);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(alertWith(page, "not valid or has expired")).toBeVisible();

  // A bare address with no secret is explained, not a blank page.
  await page.goto("/accept-invite");
  await expect(alertWith(page, "incomplete")).toBeVisible();
  await context.close();
});

test("the same sign-in page takes a customer to their own page, showing their credit and nothing else", async ({ browser }) => {
  const { context, page } = await newCustomerSession(browser, EMAIL, PASSWORD);
  await expect(page).toHaveURL(/\/portal$/);

  await expect(page.getByRole("heading", { level: 1, name: NAME })).toBeVisible();
  await expect(page.getByText("Available to purchase on credit")).toBeVisible();
  await expect(page.locator(".portal-available")).toHaveText("$9,600.00"); // $10,000 limit less the $400 charge
  await expect(page.getByText("You owe").locator("..")).toContainText("$400.00");
  await expect(page.getByText("INV-PORTAL-MINE")).toBeVisible();
  await expect(page.getByText("Net 30")).toBeVisible();

  // None of the staff side, and none of the other customer or any internal text.
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Customers" })).toHaveCount(0);
  const text = await page.locator("body").innerText();
  for (const secret of ["INV-OTHER-ONLY", OTHER, "SECRET-ENTRY-NOTE", "INTERNAL-NOTE", "Test Admin", ADMIN.username]) {
    expect(text, `must not show ${secret}`).not.toContain(secret);
  }
  await context.close();
});

test("a customer cannot reach any staff page or API, and staff cannot use the customer page", async ({ browser }) => {
  const { context, page } = await newCustomerSession(browser, EMAIL, PASSWORD);

  await page.goto("/customers");
  await expect(page).toHaveURL(/\/portal$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/portal$/);

  for (const path of ["/api/customers", `/api/customers/${customerId}`, `/api/customers/${otherId}`, `/api/customers/${customerId}/portal`, "/api/me", "/api/export/customers"]) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(401);
  }
  expect((await post(page, `/api/customers/${customerId}/ledger`, { type: "PAYMENT", amountCents: 100, entryDate: daysAgo(0) })).status).toBe(401);
  expect((await post(page, `/api/customers/${customerId}/portal`, { name: "Mallory", email: `m.${SUFFIX}@portal.example.com` })).status).toBe(401);
  await context.close();

  // And the other way round: a signed-in admin sent to /portal goes back to the staff app.
  await admin.goto("/portal");
  await expect(admin).not.toHaveURL(/\/portal/);
  await expect(admin.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
});

test("two customers signed in at once each see only their own account, whatever they try", async ({ browser }) => {
  await onboard(admin, otherId, OTHER_EMAIL, OTHER_PASSWORD);
  const mine = await newCustomerSession(browser, EMAIL, PASSWORD);
  const theirs = await newCustomerSession(browser, OTHER_EMAIL, OTHER_PASSWORD);

  await expect(mine.page.getByRole("heading", { level: 1, name: NAME })).toBeVisible();
  await expect(theirs.page.getByRole("heading", { level: 1, name: OTHER })).toBeVisible();
  await expect(theirs.page.getByText("INV-OTHER-ONLY")).toBeVisible();
  await expect(theirs.page.getByText("INV-PORTAL-MINE")).toHaveCount(0);

  // Trying to name someone else's account in the address changes nothing: the server decides whose it is.
  for (const query of [`?customerId=${otherId}`, `?id=${otherId}`, `?c=${otherId}`, `?customer=${otherId}&asOf=2000-01-01`]) {
    await mine.page.goto(`/portal${query}`);
    await expect(mine.page.getByRole("heading", { level: 1, name: NAME })).toBeVisible();
    expect(await mine.page.locator("body").innerText()).not.toContain("INV-OTHER-ONLY");
  }
  await mine.context.close();
  await theirs.context.close();
});

test("a wrong password, an unknown email and a customer who has not finished setting up all get the same words", async ({ browser }) => {
  const pending = await post(admin, `/api/customers/${customerId}/portal`, { name: "Pending Person", email: `pending.${SUFFIX}@portal.example.com` });
  expect(pending.status).toBe(201);

  const messages = new Set<string>();
  for (const [username, password] of [[EMAIL, "definitely-not-the-password"], [`nobody.${SUFFIX}@portal.example.com`, PASSWORD], [`pending.${SUFFIX}@portal.example.com`, PASSWORD], [ADMIN.username, "definitely-not-the-password"]]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel("Username or email").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    const alert = alertWith(page, "Incorrect username or password");
    await expect(alert).toBeVisible();
    messages.add((await alert.innerText()).trim());
    await expect(page).toHaveURL(/\/login/);
    await context.close();
  }
  expect(messages.size).toBe(1);
});

test("signing in sends each kind of person where they belong, even when a different page was asked for", async ({ browser }) => {
  // A signed-out visitor to the customer page is brought back to it after signing in.
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  await page.goto("/portal");
  await expect(page).toHaveURL(/\/login\?next=%2Fportal/);
  await page.getByLabel("Username or email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/portal$/);
  await visitor.close();

  // A customer who asks for a staff address (or tries to slip out with a crafted path) still lands on their own page.
  for (const next of ["/customers", "/portal/../customers", "/api/customers", "//evil.example", "https://evil.example"]) {
    const context = await browser.newContext();
    const customer = await context.newPage();
    await customer.goto(`/login?next=${encodeURIComponent(next)}`);
    await customer.getByLabel("Username or email").fill(EMAIL);
    await customer.getByLabel("Password").fill(PASSWORD);
    await customer.getByRole("button", { name: "Sign in" }).click();
    await expect(customer).toHaveURL(`${ORIGIN}/portal`);
    await context.close();
  }

  // Staff who ask for the customer page land on the dashboard.
  const staffContext = await browser.newContext();
  const staff = await staffContext.newPage();
  await staff.goto(`/login?next=${encodeURIComponent("/portal")}`);
  await staff.getByLabel("Username or email").fill(ADMIN.username);
  await staff.getByLabel("Password").fill(ADMIN.password);
  await staff.getByRole("button", { name: "Sign in" }).click();
  await expect(staff.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await staffContext.close();
});

test("customer pages are never cached, and carry no search-engine welcome", async ({ browser }) => {
  const { context, page } = await newCustomerSession(browser, EMAIL, PASSWORD);
  // The development server replaces Cache-Control with "no-cache, must-revalidate" (still never reused without checking with
  // the server). The configured value, "no-store", was confirmed against a production build: see docs/PRODUCTION.md.
  const neverReused = /no-store|no-cache/;
  const response = await page.goto("/portal");
  expect(response?.headers()["cache-control"]).toMatch(neverReused);
  expect(response?.headers()["x-robots-tag"]).toContain("noindex");
  const invite = await page.goto("/accept-invite");
  expect(invite?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(invite?.headers()["cache-control"]).toMatch(neverReused);
  await context.close();
});

test("the customer page has no serious accessibility problems, in light and dark, and fits a phone", async ({ browser }) => {
  const { context, page } = await newCustomerSession(browser, EMAIL, PASSWORD);
  await expect(page.locator(".portal-available")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`);
    expect(serious, `theme: ${theme}`).toEqual([]);
  }
  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: /Sign out/ })).toBeVisible();
  await context.close();
});

test("the accept page has no serious accessibility problems", async ({ browser }) => {
  const created = await post(admin, `/api/customers/${customerId}/portal`, { name: "Axe Person", email: `axe.${SUFFIX}@portal.example.com` });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(created.body.data?.link as string);
  await expect(page.getByRole("form", { name: "Set your password" })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  await context.close();
});

test("signing out ends the customer session and leaves nothing behind", async ({ browser }) => {
  const { context, page } = await newCustomerSession(browser, EMAIL, PASSWORD);
  const before = (await context.cookies()).map((c) => c.name);
  expect(before).toContain("credit_portal_session");

  await page.getByRole("button", { name: /Sign out/ }).click();
  await expect(page).toHaveURL(/\/login/);
  expect((await context.cookies()).map((c) => c.name)).not.toContain("credit_portal_session");

  await page.goto("/portal");
  await expect(page).toHaveURL(/\/login/);
  await context.close();
});

test("signing in as a customer on a browser where staff were signed in replaces that session instead of sitting beside it", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, ADMIN);
  expect((await context.cookies()).map((c) => c.name)).toContain("credit_session");

  // Sign out of the staff app by hand-visiting the sign-in page is not possible while signed in, so use a fresh sign-in API call.
  const response = await page.request.post("/api/auth/login", { headers: { Origin: ORIGIN }, data: { username: EMAIL, password: PASSWORD } });
  expect(response.status()).toBe(200);
  const names = (await context.cookies()).map((c) => c.name);
  expect(names).toContain("credit_portal_session");
  expect(names).not.toContain("credit_session");
  await context.close();
});

test("turning access off signs the customer out at once and blocks sign-in; turning it back on restores it", async ({ browser }) => {
  const { context, page } = await newCustomerSession(browser, EMAIL, PASSWORD);
  await expect(page.locator(".portal-available")).toBeVisible();

  await openCustomer(admin, NAME);
  await drawer(admin).getByRole("button", { name: /^Turn off access for Dana Whitfield/ }).click();
  await expect(drawer(admin).getByText("Turned off", { exact: true })).toBeVisible();

  await page.goto("/portal");
  await expect(page).toHaveURL(/\/login/);
  const blocked = await context.newPage();
  await blocked.goto("/login");
  await blocked.getByLabel("Username or email").fill(EMAIL);
  await blocked.getByLabel("Password").fill(PASSWORD);
  await blocked.getByRole("button", { name: "Sign in" }).click();
  await expect(alertWith(blocked, "Incorrect username or password")).toBeVisible();

  await drawer(admin).getByRole("button", { name: /^Turn on access for Dana Whitfield/ }).click();
  await expect(drawer(admin).getByText("Active", { exact: true })).toBeVisible();
  await blocked.getByLabel("Password").fill(PASSWORD);
  await blocked.getByRole("button", { name: "Sign in" }).click();
  await expect(blocked).toHaveURL(/\/portal$/);
  await context.close();
});

test("sending a new link signs the person out and gives a fresh one-time link", async ({ browser }) => {
  const { context, page } = await newCustomerSession(browser, EMAIL, PASSWORD);
  await expect(page.locator(".portal-available")).toBeVisible();

  await openCustomer(admin, NAME);
  await drawer(admin).getByRole("button", { name: /^Send a new link to Dana Whitfield/ }).click();
  const box = drawer(admin).getByRole("group", { name: "Invitation link" });
  await expect(box).toBeVisible();
  const link = await box.getByRole("textbox", { name: /Invitation link/ }).inputValue();
  expect(link).not.toBe(inviteLink);

  await page.goto("/portal");
  await expect(page).toHaveURL(/\/login/); // signed out everywhere

  // The old link is dead; the new one works.
  const stale = await post(admin, "/api/portal/accept", { token: new URL(inviteLink).hash.replace("#t=", ""), password: `${PASSWORD}-x` });
  expect(stale.status).toBe(400);
  expect((await post(admin, "/api/portal/accept", { token: new URL(link).hash.replace("#t=", ""), password: `${PASSWORD}-y` })).status).toBe(200);
  await context.close();
});
