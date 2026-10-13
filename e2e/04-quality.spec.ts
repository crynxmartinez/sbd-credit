import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, drawer, openCustomer, requireCredentials, signIn } from "./helpers";

test.beforeAll(requireCredentials);

/** WCAG 2.x A and AA problems that block use. Anything minor is left to a human review. */
async function seriousProblems(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => `${violation.id} (${violation.impact}): ${violation.nodes.length} element(s), e.g. ${violation.nodes[0]?.target.join(" ")}`);
}

test.describe("accessibility", () => {
  test("the sign-in page has no serious problems", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await seriousProblems(page)).toEqual([]);
  });

  test("the dashboard has no serious problems, in light and dark", async ({ page }) => {
    await signIn(page, ADMIN);
    await expect(page.getByText("Receivables aging")).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      expect(await seriousProblems(page), `theme: ${theme}`).toEqual([]);
    }
  });

  test("the customers list and an open customer have no serious problems", async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto("/customers");
    await expect(page.getByRole("button", { name: "Midwest Fabrication LLC", exact: true })).toBeVisible();
    expect(await seriousProblems(page)).toEqual([]);

    await openCustomer(page, "Midwest Fabrication LLC");
    expect(await seriousProblems(page)).toEqual([]);
    await expect(drawer(page)).toBeVisible();
  });
});

test.describe("the security policy does not break the app", () => {
  test("pages carry a nonce-based policy, and nothing of ours is blocked by it", async ({ page }) => {
    // The browser's own violation events say exactly which element was blocked and where it lives. Next's development
    // overlay (<nextjs-portal>) injects an unnonced <style> of its own; it does not exist in a production build, so it is
    // the one thing left out.
    await page.addInitScript(() => {
      const seen: Array<{ directive: string; blocked: string; host: string | null; sample: string; sourceFile: string; line: number }> = [];
      (window as unknown as { __csp: typeof seen }).__csp = seen;
      document.addEventListener("securitypolicyviolation", (event) => {
        const host = event.composedPath().find((node) => "host" in node) as (Node & { host?: Element }) | undefined;
        seen.push({
          directive: event.violatedDirective,
          blocked: event.blockedURI,
          host: host?.host?.nodeName ?? null,
          sample: event.sample,
          sourceFile: event.sourceFile,
          line: event.lineNumber,
        });
      });
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    const response = await page.goto("/login");
    const policy = response?.headers()["content-security-policy"] ?? "";
    expect(policy).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/);
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);

    await signIn(page, ADMIN);
    await page.goto("/customers");
    await openCustomer(page, "Midwest Fabrication LLC");
    await drawer(page).getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("dialog", { name: "Edit credit application" }).getByRole("button", { name: "Cancel" }).click();

    const all = await page.evaluate(() => (window as unknown as { __csp: Array<{ host: string | null; sourceFile: string }> }).__csp);
    // Anything that came from Next's own development tooling (the overlay, or the script file that builds it) is not ours.
    const fromNextDevTools = (violation: { host: string | null; sourceFile: string }) =>
      violation.host === "NEXTJS-PORTAL" || /next-devtools|next_dist_compiled_next-d/.test(violation.sourceFile);
    const violations = all.filter((violation) => !fromNextDevTools(violation));
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("an injected script cannot run: customer-supplied text is shown as text", async ({ page }) => {
    await signIn(page, ADMIN);
    const created = await page.request.post("/api/customers", {
      headers: { Origin: "http://127.0.0.1:3201" },
      data: { businessName: '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>', dateApplied: "2026-10-14", notes: "<b>bold?</b>" },
    });
    expect(created.status()).toBe(201);

    await page.goto("/customers");
    await expect(page.getByText('<img src=x onerror="window.__pwned=1">', { exact: false }).first()).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });
});

test.describe("narrow screens", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("on a phone, navigation, theme and sign-out are all reachable, and nothing scrolls sideways", async ({ page }) => {
    await signIn(page, ADMIN);
    await expect(page.getByRole("link", { name: "Customers" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Sign out/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Theme:/ })).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
