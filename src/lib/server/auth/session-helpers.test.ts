import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The session helpers read cookies and look the person up in the database. Both are replaced here with simple stand-ins, so
 * every way a session can be good or bad is tested without a browser or a database.
 */
const jar = new Map<string, string>();
const store = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  set: (name: string, value: string, options?: { maxAge?: number }) => {
    // A cookie set with maxAge 0 is how a cookie is removed (the only way that works for "__Host-" cookies in production).
    if (options?.maxAge === 0 || value === "") jar.delete(name);
    else jar.set(name, value);
  },
  delete: (name: string) => jar.delete(name),
};
vi.mock("next/headers", () => ({ cookies: async () => store }));

const appUsers = new Map<string, Record<string, unknown>>();
const customerUsers = new Map<string, Record<string, unknown>>();
let failRevocation = false;

vi.mock("../db", () => ({
  prisma: {
    appUser: {
      findUnique: async ({ where }: { where: { id: string } }) => appUsers.get(where.id) ?? null,
      updateMany: async ({ where, data }: { where: { id: string; sessionVersion: number }; data: { sessionVersion: { increment: number } } }) => {
        if (failRevocation) throw new Error("database is down");
        const user = appUsers.get(where.id);
        if (user && user.sessionVersion === where.sessionVersion) user.sessionVersion = (user.sessionVersion as number) + data.sessionVersion.increment;
        return { count: user ? 1 : 0 };
      },
    },
    customerUser: {
      findUnique: async ({ where }: { where: { id: string } }) => customerUsers.get(where.id) ?? null,
      updateMany: async ({ where, data }: { where: { id: string; sessionVersion: number }; data: { sessionVersion: { increment: number } } }) => {
        if (failRevocation) throw new Error("database is down");
        const user = customerUsers.get(where.id);
        if (user && user.sessionVersion === where.sessionVersion) user.sessionVersion = (user.sessionVersion as number) + data.sessionVersion.increment;
        return { count: user ? 1 : 0 };
      },
    },
  },
}));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), cache: <T>(fn: T) => fn }));

import { getCurrentUser, endSession, requireUser, startSession } from "./current-user";
import { endCustomerSession, getCurrentCustomerUser, startCustomerSession } from "./customer-session";
import { endAllSessions } from "./sign-out";

const staff = { id: "s1", username: "dana", name: "Dana", role: "ADMIN", active: true, sessionVersion: 3 };
const customer = { id: "k1", name: "Pat", email: "pat@example.com", customerId: "c1", active: true, passwordHash: "x", sessionVersion: 5 };

beforeEach(() => {
  process.env.SESSION_SECRET = "a-session-secret-long-enough-for-the-tests-1234";
  delete process.env.CREDIT_DEV_AUTOLOGIN;
  jar.clear();
  appUsers.clear();
  customerUsers.clear();
  failRevocation = false;
  appUsers.set(staff.id, { ...staff });
  customerUsers.set(customer.id, { ...customer });
});

describe("staff session", () => {
  test("a signed-in person is recognised, and nobody is recognised without a cookie", async () => {
    expect(await getCurrentUser()).toBeNull();
    await startSession(staff);
    expect(await getCurrentUser()).toMatchObject({ id: "s1", role: "ADMIN" });
  });

  test("a deactivated account, a bumped session version, or a deleted account ends the session at once", async () => {
    await startSession(staff);
    appUsers.get("s1")!.active = false;
    expect(await getCurrentUser()).toBeNull();
    appUsers.get("s1")!.active = true;
    appUsers.get("s1")!.sessionVersion = 4;
    expect(await getCurrentUser()).toBeNull();
    appUsers.delete("s1");
    expect(await getCurrentUser()).toBeNull();
  });

  test("a role the app does not know is not a signed-in user", async () => {
    await startSession(staff);
    appUsers.get("s1")!.role = "OWNER";
    expect(await getCurrentUser()).toBeNull();
  });

  test("requireUser answers 401 when signed out, and 403 when the role is too low", async () => {
    await expect(requireUser()).rejects.toMatchObject({ status: 401 });
    appUsers.get("s1")!.role = "EMPLOYEE";
    await startSession({ id: "s1", sessionVersion: 3 });
    await expect(requireUser("decision.approve")).rejects.toMatchObject({ status: 403 });
    await expect(requireUser("ledger.record")).resolves.toMatchObject({ id: "s1" });
  });

  test("signing out revokes the session everywhere (the version goes up) and removes the cookie", async () => {
    await startSession(staff);
    const token = jar.get("credit_session")!;
    await endSession();
    expect(jar.has("credit_session")).toBe(false);
    expect(appUsers.get("s1")!.sessionVersion).toBe(4);
    // A copy of the old token is useless now.
    jar.set("credit_session", token);
    expect(await getCurrentUser()).toBeNull();
  });

  test("if the revocation cannot be saved, sign-out FAILS and the cookie is kept, so the person can try again", async () => {
    await startSession(staff);
    failRevocation = true;
    await expect(endSession()).rejects.toMatchObject({ status: 503 });
    expect(jar.has("credit_session")).toBe(true);
    // Once the database is back, signing out works, which it could not if the cookie had been thrown away first.
    failRevocation = false;
    await endSession();
    expect(appUsers.get("s1")!.sessionVersion).toBe(4);
  });

  test("signing out with no session is a harmless no-op", async () => {
    await expect(endSession()).resolves.toBeUndefined();
  });
});

describe("customer session", () => {
  test("is recognised, and a staff cookie is not a customer session", async () => {
    await startSession(staff);
    expect(await getCurrentCustomerUser()).toBeNull();
    await startCustomerSession(customer);
    expect(await getCurrentCustomerUser()).toMatchObject({ id: "k1", customerId: "c1" });
  });

  test("a disabled account, one that never set a password, or a bumped version is not signed in", async () => {
    await startCustomerSession(customer);
    customerUsers.get("k1")!.active = false;
    expect(await getCurrentCustomerUser()).toBeNull();
    customerUsers.get("k1")!.active = true;
    customerUsers.get("k1")!.passwordHash = null;
    expect(await getCurrentCustomerUser()).toBeNull();
    customerUsers.get("k1")!.passwordHash = "x";
    customerUsers.get("k1")!.sessionVersion = 6;
    expect(await getCurrentCustomerUser()).toBeNull();
  });

  test("the customer's account is read from the database every time, never from the cookie", async () => {
    await startCustomerSession(customer);
    customerUsers.get("k1")!.customerId = "c2";
    expect(await getCurrentCustomerUser()).toMatchObject({ customerId: "c2" });
  });

  test("signing out fails (and keeps the cookie) if the revocation cannot be saved", async () => {
    await startCustomerSession(customer);
    failRevocation = true;
    await expect(endCustomerSession()).rejects.toMatchObject({ status: 503 });
    expect(jar.has("credit_portal_session")).toBe(true);
  });
});

describe("both kinds together", () => {
  test("starting one kind removes the other's cookie, so two people's sessions never sit side by side", async () => {
    await startSession(staff);
    expect(jar.has("credit_session")).toBe(true);
    await startCustomerSession(customer);
    expect(jar.has("credit_session")).toBe(false);
    expect(jar.has("credit_portal_session")).toBe(true);
    await startSession(staff);
    expect(jar.has("credit_portal_session")).toBe(false);
  });

  test("one sign-out ends whichever sessions exist", async () => {
    await startCustomerSession(customer);
    await endAllSessions();
    expect(jar.size).toBe(0);
    expect(customerUsers.get("k1")!.sessionVersion).toBe(6);
  });

  test("when the revocation cannot be saved the sign-out reports failure instead of pretending, and keeps the cookie", async () => {
    await startSession(staff);
    failRevocation = true;
    await expect(endAllSessions()).rejects.toMatchObject({ status: 503, code: "signout_failed" });
    expect(jar.has("credit_session")).toBe(true);
  });
});
