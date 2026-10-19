import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The development shortcut that skips the sign-in screen acts as the seeded admin. If its guard were ever dropped, every
 * unauthenticated request would be an administrator, and nothing else would fail. So the guard has tests of its own, in every
 * environment that must refuse it.
 */
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const devAdmin = { id: "dev1", username: "dev.admin", name: "Dev Admin", role: "SUPERADMIN", active: true, sessionVersion: 1 };
let admin: typeof devAdmin | null = devAdmin;
vi.mock("../db", () => ({
  prisma: { appUser: { findUnique: async ({ where }: { where: { username?: string } }) => (where.username === "dev.admin" ? admin : null) } },
}));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), cache: <T>(fn: T) => fn }));

import { getCurrentUser, requireUser } from "./current-user";

beforeEach(() => {
  admin = { ...devAdmin };
  vi.stubEnv("SESSION_SECRET", "a-session-secret-long-enough-for-the-tests-1234");
  vi.stubEnv("DEV_ADMIN_USERNAME", "dev.admin");
  vi.stubEnv("CREDIT_DEV_AUTOLOGIN", "1");
});
afterEach(() => vi.unstubAllEnvs());

describe("the development auto-login", () => {
  test("acts as the seeded admin in development, when switched on", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(await getCurrentUser()).toMatchObject({ id: "dev1", role: "SUPERADMIN" });
  });

  test.each(["production", "test"])("is REFUSED when NODE_ENV is %s, even with everything else set: nobody is signed in", async (env) => {
    vi.stubEnv("NODE_ENV", env);
    expect(await getCurrentUser()).toBeNull();
    await expect(requireUser()).rejects.toMatchObject({ status: 401 });
  });

  test("is off unless the switch is exactly 1", async () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const value of ["", "0", "true", "yes", "2"]) {
      vi.stubEnv("CREDIT_DEV_AUTOLOGIN", value);
      expect(await getCurrentUser(), value).toBeNull();
    }
  });

  test("needs a named dev admin, who must exist and be active", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_ADMIN_USERNAME", "");
    expect(await getCurrentUser()).toBeNull();
    vi.stubEnv("DEV_ADMIN_USERNAME", "dev.admin");
    admin = { ...devAdmin, active: false };
    expect(await getCurrentUser()).toBeNull();
    admin = null;
    expect(await getCurrentUser()).toBeNull();
  });

  test("a role the app does not know is not an admin", async () => {
    vi.stubEnv("NODE_ENV", "development");
    admin = { ...devAdmin, role: "OWNER" };
    expect(await getCurrentUser()).toBeNull();
  });
});
