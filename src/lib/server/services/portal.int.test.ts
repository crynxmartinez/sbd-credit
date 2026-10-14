import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { INVITE_TTL_MS, RESET_TTL_MS } from "@/lib/domain/portal-users";
import { prisma } from "@/lib/server/db";
import { ApiError } from "@/lib/server/http";
import type { SessionUser } from "@/lib/types";
import type { CustomerCreateInput } from "@/lib/validation";
import { hashInviteToken } from "../auth/invite-token";
import { authenticateAny } from "../auth/login";
import type { PortalUser } from "../auth/customer-session";
import { businessToday } from "../as-of";
import { createCustomer, decide, getDetail } from "./customers";
import { recordEntry, reverseEntry, voidEntry } from "./ledger";
import { acceptInvite, inviteContact, listContacts, reissueInvite, setContactActive } from "./portal-access";
import { getPortalView } from "./portal";

const ADMIN: SessionUser = { id: "u-admin", username: "admin", name: "Test Admin", role: "ADMIN" };
const EMPLOYEE: SessionUser = { id: "u-emp", username: "emp", name: "Test Employee", role: "EMPLOYEE" };
const TODAY = businessToday();
const GOOD_PASSWORD = "correct-horse-battery-9";

const profile = (name: string): CustomerCreateInput => ({
  businessName: name, contactName: null, phone: null, email: null, billingAddress: null, dateApplied: "2026-10-01",
  requestedLimitCents: null, accountingAppName: null, accountingProjectUrl: null, notes: null,
});

async function approvedCustomer(name: string): Promise<string> {
  const id = await createCustomer(profile(name), EMPLOYEE);
  await decide(id, { action: "approve", version: 1, creditLimitCents: 10_000_00, paymentTerms: "Net 30", creditStartDate: "2026-10-01" }, ADMIN);
  return id;
}

const unique = (label: string) => `${label}.${randomUUID().slice(0, 8)}@example.com`;

/** Creates a contact and walks it all the way to "can sign in". */
async function activeContact(customerId: string, email = unique("contact"), name = "Dana Whitfield") {
  const issued = await inviteContact(customerId, { name, email }, ADMIN);
  await acceptInvite(issued.token, GOOD_PASSWORD);
  return { id: issued.contact.id, email, name, customerId };
}

const asPortalUser = (c: { id: string; email: string; name: string; customerId: string }): PortalUser => ({ id: c.id, name: c.name, email: c.email, customerId: c.customerId });

async function expectApiError(promise: Promise<unknown>, status: number, code?: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
  if (code) expect((error as ApiError).code).toBe(code);
}

const entry = (type: "CHARGE" | "PAYMENT" | "WRITE_OFF", amountCents: number, extra: object = {}) => ({
  type, amountCents, entryDate: TODAY, dueDate: null, reference: null, note: null, ...extra,
});

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  expect(new URL(url).searchParams.get("schema")).toMatch(/^credit_test/);
  await prisma.$queryRaw`SELECT 1`;
});

describe("offering portal access", () => {
  test("only an admin can offer it, and only for an account that has or had credit", async () => {
    const customerId = await approvedCustomer("Invite Rules Co");
    await expectApiError(inviteContact(customerId, { name: "Dana", email: unique("d") }, EMPLOYEE), 403);

    const pending = await createCustomer(profile("Still Submitted Co"), EMPLOYEE);
    await expectApiError(inviteContact(pending, { name: "Dana", email: unique("d") }, ADMIN), 409, "invalid_state");
    await expectApiError(inviteContact("no-such-customer", { name: "Dana", email: unique("d") }, ADMIN), 404);
  });

  test("a bad name or email is refused before anything is created", async () => {
    const customerId = await approvedCustomer("Invite Validation Co");
    await expectApiError(inviteContact(customerId, { name: "  ", email: unique("d") }, ADMIN), 422);
    await expectApiError(inviteContact(customerId, { name: "Dana", email: "not-an-email" }, ADMIN), 422);
    expect(await listContacts(customerId, ADMIN)).toEqual([]);
  });

  test("the link secret is never stored: only its hash is, and the audit trail never carries it", async () => {
    const customerId = await approvedCustomer("Secret Handling Co");
    const email = unique("secret");
    const issued = await inviteContact(customerId, { name: "Dana", email }, ADMIN);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await prisma.portalInvite.findMany({ where: { customerUserId: issued.contact.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(hashInviteToken(issued.token));
    expect(JSON.stringify(stored)).not.toContain(issued.token);

    const detail = await getDetail(customerId, TODAY);
    const audit = detail.audit.find((e) => e.action === "portal.invited");
    expect(audit?.summary).toContain(email);
    expect(JSON.stringify(detail.audit)).not.toContain(issued.token);
    expect(JSON.stringify(await listContacts(customerId, ADMIN))).not.toContain(issued.token);
    expect(issued.contact).toMatchObject({ status: "invited", email, lastLoginAt: null });
    const lifetime = new Date(issued.expiresAt).getTime() - Date.now();
    expect(lifetime).toBeLessThanOrEqual(INVITE_TTL_MS);
    expect(lifetime).toBeGreaterThan(INVITE_TTL_MS - 60_000); // about seven days, not zero
  });

  test("one address is one account, whatever its case", async () => {
    const a = await approvedCustomer("Dup Email A Co");
    const b = await approvedCustomer("Dup Email B Co");
    const email = unique("dup");
    await inviteContact(a, { name: "Dana", email }, ADMIN);
    await expectApiError(inviteContact(a, { name: "Dana", email: email.toUpperCase() }, ADMIN), 409, "already_exists");
    await expectApiError(inviteContact(b, { name: "Dana", email: `  ${email}  ` }, ADMIN), 409, "already_exists");
  });
});

describe("accepting an invitation", () => {
  test("sets the password, and then the person can sign in as a customer", async () => {
    const customerId = await approvedCustomer("Accept Happy Co");
    const email = unique("happy");
    const issued = await inviteContact(customerId, { name: "Dana", email }, ADMIN);
    await expectApiError(authenticateAny(email, GOOD_PASSWORD), 401, "bad_login"); // not yet

    await acceptInvite(issued.token, GOOD_PASSWORD);
    const who = await authenticateAny(email, GOOD_PASSWORD);
    expect(who.kind).toBe("customer");
    expect(who.user).toMatchObject({ customerId, email });
    expect((await listContacts(customerId, ADMIN))[0]).toMatchObject({ status: "active" });
    expect((await getDetail(customerId, TODAY)).audit.some((e) => e.action === "portal.accepted")).toBe(true);
  });

  test("a link works once", async () => {
    const customerId = await approvedCustomer("Accept Once Co");
    const issued = await inviteContact(customerId, { name: "Dana", email: unique("once") }, ADMIN);
    await acceptInvite(issued.token, GOOD_PASSWORD);
    await expectApiError(acceptInvite(issued.token, "another-good-password-77"), 400, "invalid_invite");
  });

  test("every way a link can be unusable gets the same answer: made up, expired, replaced, used, person turned off", async () => {
    const customerId = await approvedCustomer("Accept Generic Co");
    const messages = new Set<string>();
    const refused = async (promise: Promise<unknown>) => {
      const error = (await promise.then(() => null, (caught: unknown) => caught)) as ApiError;
      expect(error).toBeInstanceOf(ApiError);
      expect(error.status).toBe(400);
      messages.add(`${error.code}|${error.message}`);
    };

    await refused(acceptInvite("A".repeat(43), GOOD_PASSWORD));

    const expired = await inviteContact(customerId, { name: "E", email: unique("exp") }, ADMIN);
    await refused(acceptInvite(expired.token, GOOD_PASSWORD, new Date(Date.now() + INVITE_TTL_MS + 60_000)));

    const replaced = await inviteContact(customerId, { name: "R", email: unique("rep") }, ADMIN);
    await reissueInvite(customerId, replaced.contact.id, ADMIN);
    await refused(acceptInvite(replaced.token, GOOD_PASSWORD));

    const used = await inviteContact(customerId, { name: "U", email: unique("used") }, ADMIN);
    await acceptInvite(used.token, GOOD_PASSWORD);
    await refused(acceptInvite(used.token, GOOD_PASSWORD));

    const off = await inviteContact(customerId, { name: "O", email: unique("off") }, ADMIN);
    await setContactActive(customerId, off.contact.id, false, ADMIN);
    await refused(acceptInvite(off.token, GOOD_PASSWORD));

    expect(messages.size).toBe(1);
  });

  test("a weak password is refused, and a password with the person's own email in it is refused WITHOUT using up the link", async () => {
    const customerId = await approvedCustomer("Accept Weak Co");
    const email = "dana.whitfield.weak@example.com";
    const issued = await inviteContact(customerId, { name: "Dana", email }, ADMIN);

    await expectApiError(acceptInvite(issued.token, "short"), 422, "weak_password");
    await expectApiError(acceptInvite(issued.token, `xx-${email}-xx`), 422, "weak_password");
    await expectApiError(acceptInvite(issued.token, "dana.whitfield.weak-is-my-password"), 422, "weak_password");
    // The link was not consumed by any of those, so a good password still works.
    await acceptInvite(issued.token, GOOD_PASSWORD);
    expect((await authenticateAny(email, GOOD_PASSWORD)).kind).toBe("customer");
  });

  test("six people racing with the same link: exactly one wins, and only the winner's password works", async () => {
    const customerId = await approvedCustomer("Accept Race Co");
    const email = unique("race");
    const issued = await inviteContact(customerId, { name: "Dana", email }, ADMIN);
    const passwords = Array.from({ length: 6 }, (_, i) => `racing-password-number-${i}-xyz`);

    const outcomes = await Promise.allSettled(passwords.map((password) => acceptInvite(issued.token, password)));
    const winners = outcomes.flatMap((outcome, index) => (outcome.status === "fulfilled" ? [passwords[index]!] : []));
    expect(winners).toHaveLength(1);

    let working = 0;
    for (const password of passwords) {
      const ok = await authenticateAny(email, password).then(() => true, () => false);
      if (ok) working += 1;
      if (ok) expect(password).toBe(winners[0]);
    }
    expect(working).toBe(1);
  });
});

describe("sending a new link", () => {
  test("cancels the old link, signs the person out, and a reset keeps the old password working until the new link is used", async () => {
    const customerId = await approvedCustomer("Reissue Co");
    const contact = await activeContact(customerId);
    const before = await prisma.customerUser.findUniqueOrThrow({ where: { id: contact.id }, select: { sessionVersion: true } });

    const fresh = await reissueInvite(customerId, contact.id, ADMIN);
    const after = await prisma.customerUser.findUniqueOrThrow({ where: { id: contact.id }, select: { sessionVersion: true } });
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    // A password reset link is short-lived.
    const lifetime = new Date(fresh.expiresAt).getTime() - Date.now();
    expect(lifetime).toBeLessThanOrEqual(RESET_TTL_MS);
    expect(lifetime).toBeGreaterThan(RESET_TTL_MS - 60_000); // about two days, not zero

    expect((await authenticateAny(contact.email, GOOD_PASSWORD)).kind).toBe("customer"); // the old password still works...
    await acceptInvite(fresh.token, "brand-new-password-4321");
    await expectApiError(authenticateAny(contact.email, GOOD_PASSWORD), 401); // ...until the new one is set
    expect((await authenticateAny(contact.email, "brand-new-password-4321")).kind).toBe("customer");
  });

  test("an older link can never be used after a newer one was sent, and only one link is ever live", async () => {
    const customerId = await approvedCustomer("Reissue Old Link Co");
    const first = await inviteContact(customerId, { name: "Dana", email: unique("old") }, ADMIN);
    const second = await reissueInvite(customerId, first.contact.id, ADMIN);

    await expectApiError(acceptInvite(first.token, GOOD_PASSWORD), 400, "invalid_invite");
    expect(await prisma.portalInvite.count({ where: { customerUserId: first.contact.id, usedAt: null, revokedAt: null } })).toBe(1);
    await acceptInvite(second.token, GOOD_PASSWORD);
  });

  test("accepting and re-sending at the same moment never leaves the old link able to set a password afterwards", async () => {
    const customerId = await approvedCustomer("Reissue Race Co");
    const issued = await inviteContact(customerId, { name: "Dana", email: unique("rr") }, ADMIN);
    const [accepted, reissued] = await Promise.allSettled([acceptInvite(issued.token, GOOD_PASSWORD), reissueInvite(customerId, issued.contact.id, ADMIN)]);

    // Neither may fail for any reason except the legitimate one: the accept losing to the re-send.
    expect(reissued.status).toBe("fulfilled");
    if (accepted.status === "rejected") expect((accepted.reason as ApiError).code).toBe("invalid_invite");

    // Whatever order they ran in, the old link is spent now, and exactly one link is live: the new one.
    await expectApiError(acceptInvite(issued.token, "a-different-good-password-1"), 400, "invalid_invite");
    expect(await prisma.portalInvite.count({ where: { customerUserId: issued.contact.id, usedAt: null, revokedAt: null } })).toBe(1);
  });

  test("another customer's admin path cannot reach this contact: it is simply not found", async () => {
    const a = await approvedCustomer("Scope A Co");
    const b = await approvedCustomer("Scope B Co");
    const contact = await activeContact(a);

    await expectApiError(reissueInvite(b, contact.id, ADMIN), 404);
    await expectApiError(setContactActive(b, contact.id, false, ADMIN), 404);
    expect(await listContacts(b, ADMIN)).toEqual([]);
    expect((await listContacts(a, ADMIN)).map((c) => c.id)).toEqual([contact.id]);
  });

  test("only an admin can send, turn off or list", async () => {
    const customerId = await approvedCustomer("Manage Roles Co");
    const contact = await activeContact(customerId);
    await expectApiError(reissueInvite(customerId, contact.id, EMPLOYEE), 403);
    await expectApiError(setContactActive(customerId, contact.id, false, EMPLOYEE), 403);
    await expectApiError(listContacts(customerId, EMPLOYEE), 403);
  });
});

describe("turning access off and on", () => {
  test("turning it off stops sign-in, signs them out, and cancels any live link; turning it on restores sign-in", async () => {
    const customerId = await approvedCustomer("Disable Co");
    const contact = await activeContact(customerId);
    const pending = await reissueInvite(customerId, contact.id, ADMIN);
    const before = await prisma.customerUser.findUniqueOrThrow({ where: { id: contact.id }, select: { sessionVersion: true } });

    const off = await setContactActive(customerId, contact.id, false, ADMIN);
    expect(off.status).toBe("disabled");
    await expectApiError(authenticateAny(contact.email, GOOD_PASSWORD), 401, "bad_login");
    await expectApiError(acceptInvite(pending.token, GOOD_PASSWORD), 400, "invalid_invite");
    await expectApiError(reissueInvite(customerId, contact.id, ADMIN), 409, "disabled");
    const mid = await prisma.customerUser.findUniqueOrThrow({ where: { id: contact.id }, select: { sessionVersion: true } });
    expect(mid.sessionVersion).toBeGreaterThan(before.sessionVersion);

    await setContactActive(customerId, contact.id, true, ADMIN);
    expect((await authenticateAny(contact.email, GOOD_PASSWORD)).kind).toBe("customer");
    const actions = (await getDetail(customerId, TODAY)).audit.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["portal.disabled", "portal.enabled", "portal.invite_resent"]));
  });
});

describe("signing in (one page for staff and customers)", () => {
  async function staffUser(username: string, password: string, extra: object = {}) {
    return prisma.appUser.create({ data: { username, name: "Staff Person", role: "EMPLOYEE", passwordHash: await bcrypt.hash(password, 4), ...extra } });
  }

  test("staff still sign in as staff, with a username", async () => {
    const username = `staff.${randomUUID().slice(0, 8)}`;
    await staffUser(username, GOOD_PASSWORD);
    const who = await authenticateAny(username.toUpperCase(), GOOD_PASSWORD);
    expect(who.kind).toBe("staff");
  });

  test("an email is matched however it was typed", async () => {
    const customerId = await approvedCustomer("Typed Email Co");
    const contact = await activeContact(customerId, unique("typed"));
    expect((await authenticateAny(`  ${contact.email.toUpperCase()}  `, GOOD_PASSWORD)).kind).toBe("customer");
  });

  test("every way of failing gets exactly the same answer, and exactly one password check is made each time", async () => {
    const customerId = await approvedCustomer("Same Answer Co");
    const good = await activeContact(customerId);
    const disabled = await activeContact(customerId);
    await setContactActive(customerId, disabled.id, false, ADMIN);
    const notInvited = await inviteContact(customerId, { name: "N", email: unique("ni") }, ADMIN);
    const locked = await activeContact(customerId);
    await prisma.customerUser.update({ where: { id: locked.id }, data: { lockedUntil: new Date(Date.now() + 3_600_000) } });

    // A staff username that is ALSO a customer's email: ambiguous, so refused for both.
    const ambiguousEmail = unique("ambig");
    const ambiguous = await activeContact(customerId, ambiguousEmail);
    await staffUser(ambiguousEmail, GOOD_PASSWORD);

    const attempts: Array<[string, string]> = [
      [good.email, "the-wrong-password-9"],
      [unique("nobody"), GOOD_PASSWORD],
      [disabled.email, GOOD_PASSWORD],
      [notInvited.contact.email, GOOD_PASSWORD],
      [locked.email, GOOD_PASSWORD],
      [ambiguousEmail, GOOD_PASSWORD],
      ["nobody.at.all", GOOD_PASSWORD],
    ];
    const compare = vi.spyOn(bcrypt, "compare");
    const answers = new Set<string>();
    try {
      for (const [identifier, password] of attempts) {
        compare.mockClear();
        const error = (await authenticateAny(identifier, password).then(() => null, (caught: unknown) => caught)) as ApiError;
        expect(error).toBeInstanceOf(ApiError);
        answers.add(`${error.status}|${error.code}|${error.message}`);
        expect(compare).toHaveBeenCalledTimes(1);
      }
    } finally {
      compare.mockRestore();
    }
    expect(answers.size).toBe(1);

    // The ambiguous name counted against neither account.
    expect((await prisma.customerUser.findUniqueOrThrow({ where: { id: ambiguous.id } })).failedLogins).toBe(0);
  });

  test("a customer is NEVER locked out by wrong guesses, however many: their email is easy to find, so a stranger could lock them out", async () => {
    const customerId = await approvedCustomer("Customer Lock Co");
    const contact = await activeContact(customerId);

    for (let i = 0; i < 6; i += 1) await expectApiError(authenticateAny(contact.email, `wrong-guess-number-${i}-zz`), 401);
    expect((await authenticateAny(contact.email, GOOD_PASSWORD)).kind).toBe("customer");

    // Far past any limit that would lock a staff account: still counted, still not locked, the right password still works.
    await prisma.customerUser.update({ where: { id: contact.id }, data: { failedLogins: 499, lockedUntil: null } });
    await expectApiError(authenticateAny(contact.email, "one-more-wrong-guess-1"), 401);
    const row = await prisma.customerUser.findUniqueOrThrow({ where: { id: contact.id } });
    expect(row).toMatchObject({ failedLogins: 500, lockedUntil: null });
    expect((await authenticateAny(contact.email, GOOD_PASSWORD)).kind).toBe("customer");
  });

  test("a staff account IS locked, even when the wrong guesses arrive all at once (the count and the lock are one statement)", async () => {
    const username = `locktest.${randomUUID().slice(0, 8)}`;
    const user = await prisma.appUser.create({ data: { username, name: "Lock Test", role: "EMPLOYEE", passwordHash: await bcrypt.hash(GOOD_PASSWORD, 4) } });

    await Promise.allSettled(Array.from({ length: 10 }, (_, i) => authenticateAny(username, `wrong-parallel-guess-${i}-zz`)));
    const row = await prisma.appUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.lockedUntil).not.toBeNull();
    expect(row.failedLogins).toBeGreaterThanOrEqual(5);
    await expectApiError(authenticateAny(username, GOOD_PASSWORD), 401, "bad_login"); // locked: even the right password is refused

    // After the lock runs out the count restarts at 1 and the account works again.
    await prisma.appUser.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    await expectApiError(authenticateAny(username, "wrong-after-the-lock-ended"), 401);
    expect(await prisma.appUser.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ failedLogins: 1, lockedUntil: null });
    expect((await authenticateAny(username, GOOD_PASSWORD)).kind).toBe("staff");
  });

  test("a successful sign-in clears failures and records when", async () => {
    const customerId = await approvedCustomer("Last Login Co");
    const contact = await activeContact(customerId);
    await expectApiError(authenticateAny(contact.email, "wrong-wrong-wrong-12"), 401);
    await authenticateAny(contact.email, GOOD_PASSWORD);
    const row = await prisma.customerUser.findUniqueOrThrow({ where: { id: contact.id } });
    expect(row.failedLogins).toBe(0);
    expect(row.lastLoginAt).not.toBeNull();
  });
});

describe("what a customer sees", () => {
  test("only their own customer: nothing from another customer or from the staff side reaches them", async () => {
    const a = await approvedCustomer("Visible Alpha Co");
    const b = await approvedCustomer("Visible Bravo Co");
    await prisma.customer.update({ where: { id: a }, data: { notes: "SECRET-NOTE-ALPHA" } });
    await recordEntry(a, entry("CHARGE", 400_00, { reference: "INV-ALPHA" }), EMPLOYEE);
    await recordEntry(b, entry("CHARGE", 900_00, { reference: "INV-BRAVO-ONLY", note: "SECRET-NOTE-BRAVO" }), EMPLOYEE);

    const contactA = await activeContact(a);
    const view = await getPortalView(asPortalUser(contactA), TODAY);
    expect(view).not.toBeNull();
    expect(view).toMatchObject({ businessName: "Visible Alpha Co", balanceCents: 400_00, creditLimitCents: 10_000_00, availableCents: 9_600_00, standing: "active" });
    const text = JSON.stringify(view);
    for (const secret of ["Bravo", "INV-BRAVO-ONLY", "SECRET-NOTE-BRAVO", "SECRET-NOTE-ALPHA", "Test Employee", "Test Admin"]) expect(text).not.toContain(secret);
    expect(view?.entries).toHaveLength(1);
  });

  test("voided entries and entries dated ahead are hidden, write-offs read as credits, and the list adds up to the balance", async () => {
    const id = await approvedCustomer("Visible Rules Co");
    const { id: voidMe } = await recordEntry(id, entry("CHARGE", 70_00, { reference: "TYPO" }), EMPLOYEE);
    await voidEntry(id, voidMe, "Entered by mistake", ADMIN);
    await recordEntry(id, entry("CHARGE", 500_00, { reference: "INV-1" }), EMPLOYEE);
    await recordEntry(id, entry("CHARGE", 800_00, { entryDate: "2099-01-01" }), EMPLOYEE);
    await recordEntry(id, entry("PAYMENT", 100_00, { reference: "Check 9" }), EMPLOYEE);
    await recordEntry(id, entry("WRITE_OFF", 50_00, { note: "SECRET-WRITE-OFF-REASON", reference: "SECRET-REF" }), ADMIN);

    const contact = await activeContact(id);
    const view = (await getPortalView(asPortalUser(contact), TODAY))!;
    expect(view.balanceCents).toBe(350_00);
    expect(view.entries.reduce((sum, e) => sum + e.amountCents, 0)).toBe(350_00);
    expect(view.entries.map((e) => e.kind).sort()).toEqual(["credit", "payment", "purchase"]);
    const text = JSON.stringify(view);
    for (const secret of ["TYPO", "SECRET-WRITE-OFF-REASON", "SECRET-REF", "Entered by mistake", "800"]) expect(text).not.toContain(secret);
  });

  test("a reversal shows as a correction, and a suspended account shows nothing left to buy", async () => {
    const id = await approvedCustomer("Visible Reversal Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 90_00), EMPLOYEE);
    await reverseEntry(id, chargeId, { reason: "Billed to the wrong customer" }, ADMIN);
    const contact = await activeContact(id);

    const view = (await getPortalView(asPortalUser(contact), TODAY))!;
    expect(view.balanceCents).toBe(0);
    expect(view.entries.map((e) => e.kind).sort()).toEqual(["correction", "purchase"]);
    expect(JSON.stringify(view)).not.toContain("wrong customer");

    await decide(id, { action: "suspend", version: 2, reason: "Internal reason SECRET-SUSPEND" }, ADMIN);
    const held = (await getPortalView(asPortalUser(contact), TODAY))!;
    expect(held).toMatchObject({ standing: "on_hold", availableCents: 0 });
    expect(JSON.stringify(held)).not.toContain("SECRET-SUSPEND");
  });

  test("a contact whose customer no longer exists gets nothing", async () => {
    expect(await getPortalView({ id: "x", name: "x", email: "x@example.com", customerId: "no-such-customer" }, TODAY)).toBeNull();
  });
});

describe("the database itself protects customer accounts", () => {
  const baseUser = (customerId: string, email: string) => ({ customerId, email, name: "Raw", createdBy: "raw", updatedAt: new Date() });

  test("an email must be lower-case, trimmed and contain an @", async () => {
    const id = await approvedCustomer("Raw Email Co");
    await expect(prisma.customerUser.create({ data: baseUser(id, "Upper@Example.com") })).rejects.toThrow();
    await expect(prisma.customerUser.create({ data: baseUser(id, " spaced@example.com") })).rejects.toThrow();
    await expect(prisma.customerUser.create({ data: baseUser(id, "no-at-sign") })).rejects.toThrow();
    await expect(prisma.customerUser.create({ data: baseUser(id, "ok@example.com") })).resolves.toBeDefined();
  });

  test("a second live invitation for the same person is refused, whatever wrote it", async () => {
    const id = await approvedCustomer("Raw Invite Co");
    const issued = await inviteContact(id, { name: "Dana", email: unique("rawinv") }, ADMIN);
    const base = { customerUserId: issued.contact.id, expiresAt: new Date(Date.now() + 3_600_000), createdBy: "raw" };
    await expect(prisma.portalInvite.create({ data: { ...base, tokenHash: randomUUID() } })).rejects.toThrow();
    // An invitation cannot be both used and replaced.
    await expect(prisma.portalInvite.create({ data: { ...base, tokenHash: randomUUID(), usedAt: new Date(), revokedAt: new Date() } })).rejects.toThrow();
  });

  test("a customer's account cannot be deleted while it has contacts (history is kept)", async () => {
    const id = await approvedCustomer("Raw Delete Co");
    await activeContact(id);
    await expect(prisma.customer.delete({ where: { id } })).rejects.toThrow();
  });
});
