import { expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

/** Sign-in details generated fresh for each run by scripts/e2e.mjs. They are never written down anywhere. */
export const ADMIN = { username: process.env.E2E_ADMIN_USERNAME ?? "", password: process.env.E2E_ADMIN_PASSWORD ?? "" };
export const EMPLOYEE = { username: process.env.E2E_EMPLOYEE_USERNAME ?? "", password: process.env.E2E_EMPLOYEE_PASSWORD ?? "" };

export function requireCredentials(): void {
  if (!ADMIN.password || !EMPLOYEE.password) {
    throw new Error("Run these tests with `npm run e2e`: it creates the sign-in accounts they need.");
  }
}

export async function signIn(page: Page, who: { username: string; password: string }, next?: string): Promise<void> {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // The sign-in page has an h1 too, so "an h1 is visible" proves nothing. Leaving the sign-in page does.
  try {
    await expect(page).not.toHaveURL(/\/login(\?|$)/, { timeout: 20_000 });
  } catch (error) {
    const shown = await page.locator(".form-error").allInnerTexts();
    throw new Error(`Sign-in as ${who.username} did not work. The page said: ${shown.join(" / ") || "(nothing)"}. ${String(error)}`);
  }
  await expect(page.locator("#main")).toBeVisible();
}

/** An alert containing this text. (Next adds its own empty role="alert" to every page, so a bare getByRole("alert") is ambiguous.) */
export const alertWith = (scope: Page | Locator, text: string | RegExp) => scope.getByRole("alert").filter({ hasText: text });

/** A status message containing this text (the toast area, the result counter and Next's own announcer all use role="status"). */
// A message is also written into a hidden live region inside an open dialog (for screen readers): that copy is not the one to look at.
export const statusWith = (scope: Page | Locator, text: string | RegExp) =>
  scope.locator('[role="status"]:not([data-toast-live])').filter({ hasText: text });

export async function newSession(browser: Browser, who: { username: string; password: string }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, who);
  return { context, page };
}

/** Opens a customer's drawer from the customers list. */
export async function openCustomer(page: Page, name: string): Promise<void> {
  await page.goto("/customers");
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name })).toBeVisible();
}

export const drawer = (page: Page) => page.getByRole("dialog");

/** Reads the big "Outstanding balance" figure from an open drawer. */
export async function balanceText(page: Page): Promise<string> {
  const text = await drawer(page).locator(".balance-big").first().innerText();
  return text.trim();
}

/**
 * A calendar day (YYYY-MM-DD) `days` before today IN THE ZONE THE BOOKS ARE KEPT IN (the app's default, America/Chicago), never the
 * machine's own: a browser or a CI runner in another zone is on a different day for part of every 24 hours, and a test that used
 * its own clock would then date entries "tomorrow" or "yesterday" as far as the server is concerned.
 */
export function businessDaysAgo(days: number, timeZone = "America/Chicago"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - days * 86_400_000));
}
