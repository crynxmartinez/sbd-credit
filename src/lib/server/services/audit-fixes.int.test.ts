import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import { SESSION_EPOCH_SECONDS } from "@/lib/domain/backup";
import { addDays } from "@/lib/domain/dates";
import { prisma } from "@/lib/server/db";
import { ApiError } from "@/lib/server/http";
import { customerListCache } from "@/lib/server/list-cache";
import { readRoleFacts } from "@/lib/server/role-check";
import { NoSuchContact, endAllSessions, eraseContact, recordAccountEvent } from "@/lib/server/account-admin";
import { transaction } from "@/lib/server/tx";
import type { SessionUser } from "@/lib/types";
import type { CustomerCreateInput } from "@/lib/validation";
import { businessToday } from "../as-of";
import { createCustomer, decide, getDetail, updateCustomer } from "./customers";
import { ledgerCsv } from "./exports";
import { inviteContact } from "./portal-access";
import { recordEntry, reverseEntry, voidEntry } from "./ledger";

/**
 * Behaviour added by the audit of 2026-10-19 that only a real database can prove: the new constraints and triggers, the operator
 * tools, the paged export, and the rules the audit found untested (cross-customer ids, races, rollback).
 */
const ADMIN: SessionUser = { id: "u-admin", username: "admin", name: "Test Admin", role: "ADMIN" };
const EMPLOYEE: SessionUser = { id: "u-emp", username: "emp", name: "Test Employee", role: "EMPLOYEE" };
const TODAY = businessToday();
const LAST_MONTH = addDays(`${TODAY.slice(0, 8)}01`, -1);

const profile = (name: string, extra: Partial<CustomerCreateInput> = {}): CustomerCreateInput => ({
  businessName: name, contactName: null, phone: null, email: null, billingAddress: null, dateApplied: "2026-10-01",
  requestedLimitCents: null, accountingAppName: null, accountingProjectUrl: null, notes: null, ...extra,
});

async function approvedCustomer(name: string, limitCents = 10_000_00): Promise<string> {
  const id = await createCustomer(profile(name), EMPLOYEE);
  await decide(id, { action: "approve", version: 1, creditLimitCents: limitCents, paymentTerms: "Net 30", creditStartDate: "2026-10-01" }, ADMIN);
  return id;
}

const entry = (type: "CHARGE" | "PAYMENT" | "ADJUSTMENT" | "WRITE_OFF", amountCents: number, extra: object = {}) => ({
  type, amountCents, entryDate: TODAY, dueDate: null, reference: null, note: null, ...extra,
});

async function expectApiError(promise: Promise<unknown>, status: number, code?: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
  if (code) expect((error as ApiError).code).toBe(code);
}

beforeAll(async () => {
  expect(new URL(process.env.DATABASE_URL ?? "").searchParams.get("schema")).toMatch(/^credit_test/);
  await prisma.$queryRaw`SELECT 1`;
});

describe("the database now refuses more", () => {
  test("a ledger entry's other columns are frozen even if nobody listed them: only voiding changes a row", async () => {
    const id = await approvedCustomer("Frozen Whole Row Co");
    const charge = await recordEntry(id, entry("CHARGE", 50_00, { reference: "INV-F" }), ADMIN);
    for (const change of [{ reference: "INV-CHANGED" }, { note: "edited" }, { createdBy: "someone else" }, { amountCents: 1 }]) {
      await expect(prisma.ledgerEntry.update({ where: { id: charge.id }, data: change }), JSON.stringify(change)).rejects.toThrow(/append-only/);
    }
    await voidEntry(id, charge.id, "Typo", ADMIN); // the one allowed change still works
    await expect(prisma.ledgerEntry.update({ where: { id: charge.id }, data: { reference: "after void" } })).rejects.toThrow(/voided ledger entry cannot be changed/);
  });

  test("a staff username must look like one (no @), and a session version is never below 1", async () => {
    const base = { name: "T", role: "EMPLOYEE", passwordHash: "x" };
    await expect(prisma.appUser.create({ data: { ...base, username: `a@b-${randomUUID().slice(0, 6)}.example` } })).rejects.toThrow(/AppUser_username_format/);
    await expect(prisma.appUser.create({ data: { ...base, username: "ab" } })).rejects.toThrow(/AppUser_username_format/);
    await expect(prisma.appUser.create({ data: { ...base, username: `ok.${randomUUID().slice(0, 8)}`, sessionVersion: 0 } })).rejects.toThrow(/sessionVersion_positive/);
  });

  test("payment terms must be one the app knows (an unknown value used to become Net 30 without a word)", async () => {
    const id = await approvedCustomer("Terms Check Co");
    await expect(prisma.customer.update({ where: { id }, data: { paymentTerms: "Net 365" } })).rejects.toThrow(/paymentTerms_known/);
  });

  test("the account-event log is append-only", async () => {
    await recordAccountEvent(prisma, { action: "test-event", targetUsername: "nobody", details: { why: "test" }, actor: "tester" });
    const row = await prisma.accountEvent.findFirstOrThrow({ where: { action: "test-event" }, orderBy: { createdAt: "desc" } });
    await expect(prisma.accountEvent.update({ where: { id: row.id }, data: { actor: "x" } })).rejects.toThrow(/append-only/);
    await expect(prisma.accountEvent.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });
});

describe("operator tools", () => {
  test("ending every session sets each version above anything it could have reached, and records that it was done", async () => {
    const username = `sess.${randomUUID().slice(0, 8)}`;
    const user = await prisma.appUser.create({ data: { username, name: "Sess", role: "EMPLOYEE", passwordHash: "x", sessionVersion: 5 } });
    const result = await endAllSessions(prisma);
    expect(result.staff).toBeGreaterThanOrEqual(1);
    const after = await prisma.appUser.findUniqueOrThrow({ where: { id: user.id } });
    const floor = Math.floor(Date.now() / 1000) - SESSION_EPOCH_SECONDS;
    expect(after.sessionVersion).toBeGreaterThanOrEqual(floor - 5);
    expect(after.sessionVersion).toBeLessThan(2 ** 31 - 1);
    expect(await prisma.accountEvent.count({ where: { action: "end-all-sessions" } })).toBeGreaterThanOrEqual(1);
  });

  test("erasing a contact removes their name and email from the append-only audit log, and nowhere else is touched", async () => {
    const mine = await approvedCustomer("Erase Mine Co");
    const other = await approvedCustomer("Erase Other Co");
    const email = `erase.${randomUUID().slice(0, 8)}@erase-test.example`;
    const name = 'Dana "The Quote" O\'Neil';
    await inviteContact(mine, { name, email }, ADMIN);
    await inviteContact(other, { name: "Someone Else", email: `else.${randomUUID().slice(0, 8)}@erase-test.example` }, ADMIN);

    const before = await prisma.auditEvent.findMany({ where: { customerId: mine } });
    expect(JSON.stringify(before)).toContain(email);

    const { auditRows } = await eraseContact(prisma, email.toUpperCase(), "tester");
    expect(auditRows).toBeGreaterThanOrEqual(1);

    const after = await prisma.auditEvent.findMany({ where: { customerId: mine } });
    expect(JSON.stringify(after)).not.toContain(email);
    expect(JSON.stringify(after)).not.toContain("The Quote");
    expect(JSON.stringify(after)).toContain("erased+");
    // Another customer's history is untouched.
    expect(JSON.stringify(await prisma.auditEvent.findMany({ where: { customerId: other } }))).toContain("Someone Else");

    const contact = await prisma.customerUser.findFirstOrThrow({ where: { customerId: mine } });
    expect(contact).toMatchObject({ name: "[erased contact]", active: false, passwordHash: null });
    expect(contact.email).toMatch(/^erased\+.+@erased\.invalid$/);

    // The audit log is protected again afterwards.
    await expect(prisma.auditEvent.update({ where: { id: after[0]!.id }, data: { actor: "x" } })).rejects.toThrow(/append-only/);
    expect(await prisma.accountEvent.count({ where: { action: "erase-contact", actor: "tester" } })).toBe(1);
  });

  test("erasing someone who does not exist says so and changes nothing, and a failure part-way leaves the audit log protected", async () => {
    await expect(eraseContact(prisma, "nobody@erase-test.example")).rejects.toBeInstanceOf(NoSuchContact);
    // Protection is on: an update is refused.
    const any = await prisma.auditEvent.findFirstOrThrow();
    await expect(prisma.auditEvent.update({ where: { id: any.id }, data: { actor: "x" } })).rejects.toThrow(/append-only/);
  });

  test("the login the tests use can be asked who it is (the query behind the startup check works)", async () => {
    const facts = await readRoleFacts();
    for (const key of ["rolsuper", "rolcreaterole", "rolcreatedb", "canCreate", "canDelete", "canTruncate", "canTrigger", "canUpdateAudit", "ownsTables"] as const) {
      expect(typeof facts[key], key).toBe("boolean");
    }
  });
});

describe("customers and entries", () => {
  test("correcting the application date moves the review clock while the application is still waiting, and not afterwards", async () => {
    const id = await createCustomer(profile("Clock Co", { dateApplied: "2026-10-01" }), EMPLOYEE);
    await updateCustomer(id, { ...profile("Clock Co", { dateApplied: "2026-10-12" }), version: 1 }, EMPLOYEE);
    expect((await getDetail(id, TODAY)).customer).toMatchObject({ dateApplied: "2026-10-12", statusChangedDate: "2026-10-12" });

    await decide(id, { action: "approve", version: 2, creditLimitCents: 1_000_00, paymentTerms: "Net 30", creditStartDate: "2026-10-12" }, ADMIN);
    const approved = (await getDetail(id, TODAY)).customer;
    await updateCustomer(id, { ...profile("Clock Co", { dateApplied: "2026-10-05" }), version: approved.version }, EMPLOYEE);
    expect((await getDetail(id, TODAY)).customer).toMatchObject({ dateApplied: "2026-10-05", statusChangedDate: approved.statusChangedDate });
  });

  test("a retry of an entry that was recorded and then voided is told so, not 'already recorded'", async () => {
    const id = await approvedCustomer("Voided Retry Co");
    const key = randomUUID();
    const first = await recordEntry(id, entry("CHARGE", 70_00, { requestKey: key }), EMPLOYEE);
    await voidEntry(id, first.id, "Wrong customer", ADMIN);
    await expectApiError(recordEntry(id, entry("CHARGE", 70_00, { requestKey: key }), EMPLOYEE), 409, "entry_voided");
  });

  test("a retry of a post-dated entry still says it is post-dated", async () => {
    const id = await approvedCustomer("Retry Future Co");
    const key = randomUUID();
    const ahead = addDays(TODAY, 10);
    const first = await recordEntry(id, entry("CHARGE", 20_00, { requestKey: key, entryDate: ahead, dueDate: addDays(ahead, 30) }), EMPLOYEE);
    expect(first.postDated).toBe(true);
    const again = await recordEntry(id, entry("CHARGE", 20_00, { requestKey: key, entryDate: ahead, dueDate: addDays(ahead, 30) }), EMPLOYEE);
    expect(again).toMatchObject({ id: first.id, duplicate: true, postDated: true });
  });

  test("an entry cannot be corrected through ANOTHER customer's path, even by an admin who knows its id", async () => {
    const a = await approvedCustomer("Path A Co");
    const b = await approvedCustomer("Path B Co");
    const theirs = await recordEntry(b, entry("CHARGE", 30_00), ADMIN);
    await expectApiError(voidEntry(a, theirs.id, "Not yours", ADMIN), 404, "not_found");
    await expectApiError(reverseEntry(a, theirs.id, { reason: "Not yours" }, ADMIN), 404, "not_found");
    const ledger = (await getDetail(b, TODAY)).ledger;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ voided: false, reversed: false });
  });

  test("recording against a customer that does not exist is a 404, not a crash", async () => {
    await expectApiError(recordEntry("no-such-customer", entry("CHARGE", 1_00), ADMIN), 404, "not_found");
  });

  test("a negative adjustment on an approved account with no entries is accepted and leaves a credit balance (it is signed, like a payment)", async () => {
    const id = await approvedCustomer("Empty Adjust Co");
    await recordEntry(id, entry("ADJUSTMENT", -5_00), ADMIN);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(-5_00);
  });

  test("the over-limit warning starts exactly AT the limit, not above it", async () => {
    const id = await approvedCustomer("Limit Edge Co", 500_00);
    expect((await recordEntry(id, entry("CHARGE", 499_99), EMPLOYEE)).warning).toBeNull(); // one cent under
    const second = await approvedCustomer("Limit Edge Two Co", 500_00);
    expect((await recordEntry(second, entry("CHARGE", 500_00), EMPLOYEE)).warning).toBe("over_limit"); // exactly the limit
  });
});

describe("the workflow, end to end", () => {
  test("approve straight from submitted, deny, reopen, and approve again with new terms: the ledger is untouched throughout", async () => {
    const id = await createCustomer(profile("Workflow Co"), EMPLOYEE);
    await decide(id, { action: "approve", version: 1, creditLimitCents: 1_000_00, paymentTerms: "Net 30", creditStartDate: "2026-10-01" }, ADMIN);
    await recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE);
    await decide(id, { action: "suspend", version: 2, reason: "Late" }, ADMIN);
    await decide(id, { action: "reopen", version: 3 }, ADMIN);
    await decide(id, { action: "deny", version: 4, reason: "Not eligible" }, ADMIN);
    expect((await getDetail(id, TODAY)).customer.status).toBe("denied");
    await decide(id, { action: "reopen", version: 5 }, ADMIN);
    await decide(id, { action: "approve", version: 6, creditLimitCents: 2_000_00, paymentTerms: "Net 45", creditStartDate: TODAY }, ADMIN);
    const { customer, ledger } = await getDetail(id, TODAY);
    expect(customer).toMatchObject({ status: "approved", creditLimitCents: 2_000_00, paymentTerms: "Net 45", balanceCents: 100_00 });
    expect(ledger).toHaveLength(1);
  });

  test("an employee cannot decide anything, over the real service", async () => {
    const id = await createCustomer(profile("Employee Decide Co"), EMPLOYEE);
    await expectApiError(decide(id, { action: "approve", version: 1, creditLimitCents: 1_000_00, paymentTerms: "Net 30", creditStartDate: TODAY }, EMPLOYEE), 403);
    await expectApiError(decide(id, { action: "deny", version: 1, reason: null }, EMPLOYEE), 403);
  });
});

describe("races and rollback", () => {
  test("two write-offs for the same open charge at once: exactly one is recorded", async () => {
    const id = await approvedCustomer("Racing Write Offs Co");
    await recordEntry(id, entry("CHARGE", 100_00, { reference: "INV-R" }), ADMIN);
    const attempt = () => recordEntry(id, entry("WRITE_OFF", 100_00, { note: "Uncollectible", requestKey: randomUUID() }), ADMIN);
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((failure.reason as ApiError).status).toBe(409);
    expect((await getDetail(id, TODAY)).customer).toMatchObject({ balanceCents: 0, writtenOffCents: 100_00 });
  });

  test("a write-off racing the void of the charge it would cover: never both", async () => {
    const id = await approvedCustomer("Racing Void Co");
    const charge = await recordEntry(id, entry("CHARGE", 80_00, { reference: "INV-V" }), ADMIN);
    const results = await Promise.allSettled([
      recordEntry(id, entry("WRITE_OFF", 80_00, { note: "Uncollectible", requestKey: randomUUID() }), ADMIN),
      voidEntry(id, charge.id, "Typo", ADMIN),
    ]);
    const detail = await getDetail(id, TODAY);
    const chargeRow = detail.ledger.find((row) => row.id === charge.id)!;
    const writeOffs = detail.ledger.filter((row) => row.type === "WRITE_OFF" && !row.voided);
    // Whichever ran first wins; the books never end up with a live write-off for a voided charge.
    expect(chargeRow.voided && writeOffs.length > 0).toBe(false);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(detail.customer.balanceCents).toBeGreaterThanOrEqual(0);
  });

  test("a failure after the first insert leaves nothing behind: the whole write rolls back", async () => {
    const id = await approvedCustomer("Rollback Co");
    await expect(
      transaction(async (tx) => {
        await tx.ledgerEntry.create({ data: { customerId: id, type: "CHARGE", amountCents: 12_34, entryDate: new Date(`${TODAY}T00:00:00Z`), createdBy: "t" } });
        throw new Error("something went wrong after the insert");
      }),
    ).rejects.toThrow(/something went wrong/);
    expect((await getDetail(id, TODAY)).ledger).toHaveLength(0);
  });

  test("a write-off whose allocation step fails (a charge from another customer) leaves no write-off row behind", async () => {
    const a = await approvedCustomer("Rollback Alloc A Co");
    const b = await approvedCustomer("Rollback Alloc B Co");
    await recordEntry(a, entry("CHARGE", 50_00), ADMIN);
    const theirs = await recordEntry(b, entry("CHARGE", 50_00), ADMIN);
    await expectApiError(recordEntry(a, entry("WRITE_OFF", 50_00, { note: "Uncollectible", allocations: [{ chargeId: theirs.id, amountCents: 50_00 }] }), ADMIN), 409, "invalid_allocation");
    expect((await getDetail(a, TODAY)).ledger.filter((row) => row.type === "WRITE_OFF")).toHaveLength(0);
  });

  test("an older (unallocated) write-off still protects the balance: a charge that would push it below zero cannot be voided", async () => {
    const id = await approvedCustomer("Legacy Safe Co");
    const charge = await recordEntry(id, entry("CHARGE", 100_00, { entryDate: LAST_MONTH, dueDate: LAST_MONTH }), ADMIN);
    await prisma.ledgerEntry.create({
      data: { customerId: id, type: "WRITE_OFF", amountCents: 100_00, entryDate: new Date(`${LAST_MONTH}T00:00:00Z`), note: "Uncollectible", createdBy: "legacy", allocationsRequired: false },
    });
    // Balance is 0; reversing the charge would make it -100 while the write-off still stands.
    await expectApiError(reverseEntry(id, charge.id, { reason: "Wrong customer" }, ADMIN), 409, "write_off_covers");
    // A second charge on top is free to correct: the balance stays at or above zero.
    const extra = await recordEntry(id, entry("CHARGE", 40_00), ADMIN);
    await voidEntry(id, extra.id, "Typo", ADMIN);
  });
});

describe("the customer list cache and the paged export", () => {
  test("any committed write makes the next list computation run again", async () => {
    const key = `cache-test-${randomUUID()}`;
    let computed = 0;
    const compute = async () => {
      computed += 1;
      return "{}";
    };
    await customerListCache.get(key, compute);
    await customerListCache.get(key, compute);
    expect(computed).toBe(1);
    await createCustomer(profile("Cache Bump Co"), EMPLOYEE);
    await customerListCache.get(key, compute);
    expect(computed).toBe(2);
  });

  test("the export is the same whatever the page size, with one header and no row twice or missing", async () => {
    const id = await approvedCustomer("Paged Export Co");
    for (let i = 0; i < 7; i += 1) await recordEntry(id, entry("CHARGE", 10_00 + i, { reference: `PAGED-${i}` }), ADMIN);
    const small = await ledgerCsv(TODAY, 3);
    const large = await ledgerCsv(TODAY, 5_000);
    expect(small).toBe(large);
    const lines = small.split("\r\n").filter(Boolean);
    expect(lines[0]).toMatch(/^Customer ID,Business,Type/);
    expect(lines.filter((line) => line.startsWith("Customer ID,"))).toHaveLength(1);
    const mine = lines.filter((line) => line.includes("PAGED-"));
    expect(mine).toHaveLength(7);
    expect(new Set(mine).size).toBe(7);
  });
});
