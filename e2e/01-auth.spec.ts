import { expect, test } from "@playwright/test";
import { ADMIN, alertWith, requireCredentials, signIn, statusWith } from "./helpers";

test.beforeAll(requireCredentials);

test.describe("signing in and out", () => {
  test("a wrong password shows one generic error and stays on the sign-in page", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username").fill(ADMIN.username);
    await page.getByLabel("Password").fill("definitely-not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(alertWith(page, "Incorrect username or password")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("an unknown username gets exactly the same message (no way to find out who exists)", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username").fill("nobody.at.all");
    await page.getByLabel("Password").fill("whatever-it-is-123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alertWith(page, "Incorrect username or password, or too many recent attempts.")).toBeVisible();
  });

  test("a protected page sends a signed-out visitor to sign in, then brings them back to it", async ({ page }) => {
    await page.goto("/customers?status=approved");
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel("Username").fill(ADMIN.username);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/customers\?status=approved/);
    await expect(page.getByRole("heading", { level: 1, name: "Customers" })).toBeVisible();
  });

  test("the sign-in page will not bounce a person to another site", async ({ page }) => {
    await signIn(page, ADMIN, "https://evil.example/steal");
    await expect(page).toHaveURL(/127\.0\.0\.1/);
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  });

  test("when sign-out cannot reach the server it says so, and the person stays signed in", async ({ page }) => {
    await signIn(page, ADMIN);
    await page.route("**/api/auth/logout", (route) => route.abort("failed"));

    await page.getByRole("button", { name: "Sign out" }).click();

    await expect(statusWith(page, "Couldn't sign out")).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
  });

  test("a session that ends while working returns to sign-in, remembering where they were", async ({ page, context }) => {
    await signIn(page, ADMIN);
    await page.goto("/customers");
    await expect(page.getByRole("button", { name: "New credit application" })).toBeVisible();
    await context.clearCookies();
    // Opening the form refreshes the data, which is how the app learns the session has ended. The background refresh can
    // learn it first and leave the page before this click lands; either order must end at sign-in.
    await page.getByRole("button", { name: "New credit application" }).click({ timeout: 5_000 }).catch(() => undefined);

    await expect(page).toHaveURL(/\/login\?next=%2Fcustomers/);
  });

  // Last in this file on purpose: signing out ends every session that user has, which would cut off other tests' sessions.
  test("signing out ends the session: the app cannot be reached again without signing in", async ({ page }) => {
    await signIn(page, ADMIN);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    const response = await page.request.get("/api/customers");
    expect(response.status()).toBe(401);
  });
});
