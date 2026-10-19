import { beforeAll, describe, expect, test } from "vitest";
import { ApiError } from "@/lib/server/http";
import { prisma } from "@/lib/server/db";
import type { SessionUser } from "@/lib/types";
import type { CustomerCreateInput, DecisionInput } from "@/lib/validation";
import { randomUUID } from "node:crypto";
import { createCustomer, decide, getDetail, listSummaries, updateCustomer } from "./customers";
import { addDays } from "@/lib/domain/dates";
import { businessToday } from "../as-of";
import { recordEntry, reverseEntry, voidEntry } from "./ledger";
import { DB_REFUSAL } from "./db-refusal";

const ADMIN: SessionUser = { id: "u-admin", username: "admin", name: "Test Admin", role: "ADMIN" };
const EMPLOYEE: SessionUser = { id: "u-emp", username: "emp", name: "Test Employee", role: "EMPLOYEE" };
/** The real business day: voiding depends on which month an entry falls in, so a fixed date would rot into a failing test. */
const TODAY = businessToday();
/** A day in the previous month, which is closed. */
const LAST_MONTH = addDays(`${TODAY.slice(0, 8)}01`, -1);
/** A date ahead of today, within the 90 days an entry may be dated forward. */
const AHEAD = addDays(TODAY, 30);

const profile = (name: string): CustomerCreateInput => ({
  businessName: name,
  contactName: null,
  phone: null,
  email: null,
  billingAddress: null,
  dateApplied: "2026-10-01",
  requestedLimitCents: null,
  accountingAppName: null,
  accountingProjectUrl: null,
  notes: null,
});

const approval = (version: number, limitCents = 10_000_00): DecisionInput => ({
  action: "approve",
  version,
  creditLimitCents: limitCents,
  paymentTerms: "Net 30",
  creditStartDate: "2026-10-01",
});

/** Creates a customer and walks it to "approved" so ledger entries are allowed. */
async function approvedCustomer(name: string, limitCents = 10_000_00): Promise<string> {
  const id = await createCustomer(profile(name), EMPLOYEE);
  await decide(id, approval(1, limitCents), ADMIN);
  return id;
}

const entry = (type: "CHARGE" | "PAYMENT" | "ADJUSTMENT" | "WRITE_OFF", amountCents: number, extra: object = {}) => ({
  type,
  amountCents,
  entryDate: TODAY,
  dueDate: null,
  reference: null,
  note: null,
  ...extra,
});

async function expectApiError(promise: Promise<unknown>, status: number) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

beforeAll(async () => {
  // Fail loudly if this is ever pointed at the wrong place.
  const url = process.env.DATABASE_URL ?? "";
  expect(new URL(url).searchParams.get("schema")).toMatch(/^credit_test/);
  await prisma.$queryRaw`SELECT 1`;
});

describe("concurrent writes", () => {
  test("simultaneous payments are all kept and the balance is exact", async () => {
    // Writes to one customer queue behind its row lock. Four keeps the test inside the lock timeout even over the
    // slow remote link this suite runs against; the property proven is the same as for forty.
    const id = await approvedCustomer("Concurrent Payments Co");
    await recordEntry(id, entry("CHARGE", 1_000_00), EMPLOYEE);

    await Promise.all(Array.from({ length: 4 }, () => recordEntry(id, entry("PAYMENT", 10_00), EMPLOYEE)));

    const detail = await getDetail(id, TODAY);
    expect(detail.ledger.filter((e) => e.type === "PAYMENT")).toHaveLength(4);
    expect(detail.customer.balanceCents).toBe(960_00);
    // The old design overwrote a stored balance, so this is the case it lost money on.
  });

  test("two edits from the same version: one wins, the other is told it is stale", async () => {
    const id = await createCustomer(profile("Stale Edit Co"), EMPLOYEE);
    const edit = (name: string) => updateCustomer(id, { ...profile(name), version: 1 }, EMPLOYEE);

    const results = await Promise.allSettled([edit("First Edit"), edit("Second Edit")]);
    const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect((failures[0]!.reason as ApiError).status).toBe(409);
    expect((await getDetail(id, TODAY)).customer.version).toBe(2);
  });

  test("two admins deciding at once: exactly one decision applies", async () => {
    const id = await createCustomer(profile("Double Decision Co"), EMPLOYEE);
    const results = await Promise.allSettled([
      decide(id, approval(1), ADMIN),
      decide(id, { action: "deny", version: 1, reason: null }, ADMIN),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await getDetail(id, TODAY)).customer.version).toBe(2);
  });

  test("voiding the same entry twice at once voids it once (the repeat is a harmless no-op)", async () => {
    const id = await approvedCustomer("Double Void Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 500_00), EMPLOYEE);

    const results = await Promise.allSettled([
      voidEntry(id, chargeId, "Entered twice", ADMIN),
      voidEntry(id, chargeId, "Entered twice", ADMIN),
    ]);
    // Same person, same reason: the second is recognised as a retry and succeeds without doing anything.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const detail = await getDetail(id, TODAY);
    expect(detail.customer.balanceCents).toBe(0);
    expect(detail.audit.filter((e) => e.action === "ledger.void")).toHaveLength(1);
  });

});

describe("ledger writes lock the customer", () => {
  /** Holds the customer's row lock in a separate transaction until released, so writers started meanwhile queue behind it IN ORDER. */
  async function holdCustomerLock(customerId: string) {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let acquired: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const finished = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
        acquired();
        await released;
      },
      { timeout: 30_000 },
    );
    await ready;
    return { release: async () => { release(); await finished; } };
  }
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test("a charge that was waiting for the lock BEFORE a suspension is recorded, then the suspension applies", async () => {
    const id = await approvedCustomer("Charge Then Suspend Co");
    const hold = await holdCustomerLock(id);
    const charge = recordEntry(id, entry("CHARGE", 50_00), EMPLOYEE);
    await pause(500);
    const suspend = decide(id, { action: "suspend", version: 2, reason: "Race" }, ADMIN);
    await pause(500);
    await hold.release();

    const [chargeResult, suspendResult] = await Promise.allSettled([charge, suspend]);
    expect(chargeResult.status).toBe("fulfilled");
    expect(suspendResult.status).toBe("fulfilled");
    const detail = await getDetail(id, TODAY);
    expect(detail.customer.status).toBe("suspended");
    expect(detail.ledger.filter((e) => e.type === "CHARGE")).toHaveLength(1);
  });

  test("a suspension that was waiting BEFORE a charge wins: the charge is refused and nothing lands on the suspended account", async () => {
    const id = await approvedCustomer("Suspend Then Charge Co");
    const hold = await holdCustomerLock(id);
    const suspend = decide(id, { action: "suspend", version: 2, reason: "Race" }, ADMIN);
    await pause(500);
    const charge = recordEntry(id, entry("CHARGE", 50_00), EMPLOYEE);
    await pause(500);
    await hold.release();

    const [suspendResult, chargeResult] = await Promise.allSettled([suspend, charge]);
    expect(suspendResult.status).toBe("fulfilled");
    expect(chargeResult.status).toBe("rejected");
    expect((chargeResult as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: "invalid_state" });
    const detail = await getDetail(id, TODAY);
    expect(detail.customer.status).toBe("suspended");
    expect(detail.ledger.filter((e) => e.type === "CHARGE")).toHaveLength(0);
  });

  test("two charges that together pass the limit: the second is told, using the first", async () => {
    const id = await approvedCustomer("Limit Race Co", 1_000_00);
    const results = await Promise.all([
      recordEntry(id, entry("CHARGE", 600_00), EMPLOYEE),
      recordEntry(id, entry("CHARGE", 600_00), EMPLOYEE),
    ]);
    // Serialized by the row lock: exactly one of them is the charge that crosses the limit.
    expect(results.filter((r) => r.warning === "over_limit")).toHaveLength(1);
  });
});

describe("the database itself refuses to break the ledger", () => {
  test("ledger rows cannot be edited or deleted; audit rows cannot be changed at all", async () => {
    const id = await approvedCustomer("Append Only Co");
    const { id: entryId } = await recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE);

    await expect(prisma.ledgerEntry.update({ where: { id: entryId }, data: { amountCents: 1 } })).rejects.toThrow(/append-only/);
    await expect(prisma.ledgerEntry.update({ where: { id: entryId }, data: { note: "rewritten" } })).rejects.toThrow(/append-only/);
    await expect(prisma.ledgerEntry.delete({ where: { id: entryId } })).rejects.toThrow(/append-only/);

    const event = (await prisma.auditEvent.findFirst({ where: { customerId: id } }))!;
    await expect(prisma.auditEvent.update({ where: { id: event.id }, data: { summary: "edited" } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append-only/);
  });

  test("the whole history cannot be wiped with TRUNCATE either", async () => {
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "LedgerEntry" CASCADE')).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditEvent"')).rejects.toThrow(/append-only/);
  });

  test("the same request key cannot be stored twice for one customer, whoever writes it", async () => {
    const id = await approvedCustomer("Unique Key Co");
    const base = { customerId: id, type: "CHARGE", amountCents: 5, entryDate: new Date("2026-10-13T00:00:00Z"), createdBy: "raw", requestKey: "same-key" };
    await prisma.ledgerEntry.create({ data: base });
    await expect(prisma.ledgerEntry.create({ data: base })).rejects.toThrow(DB_REFUSAL);
  });

  test("a void is the one allowed change, and it cannot be undone", async () => {
    const id = await approvedCustomer("Void Only Co");
    const { id: entryId } = await recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE);
    await voidEntry(id, entryId, "Entered twice", ADMIN);

    await expect(prisma.ledgerEntry.update({ where: { id: entryId }, data: { voidedAt: null, voidedBy: null, voidReason: null } })).rejects.toThrow(DB_REFUSAL);
  });

  test("bad data is refused whatever wrote it", async () => {
    const id = await approvedCustomer("Constraint Co");
    const base = { customerId: id, entryDate: new Date("2026-10-13T00:00:00Z"), createdBy: "raw" };

    await expect(prisma.ledgerEntry.create({ data: { ...base, type: "PAYMENT", amountCents: -5 } })).rejects.toThrow(DB_REFUSAL);
    await expect(prisma.ledgerEntry.create({ data: { ...base, type: "CHARGE", amountCents: 0 } })).rejects.toThrow(DB_REFUSAL);
    await expect(prisma.ledgerEntry.create({ data: { ...base, type: "REFUND", amountCents: 5 } })).rejects.toThrow(DB_REFUSAL);
    await expect(prisma.ledgerEntry.create({ data: { ...base, type: "ADJUSTMENT", amountCents: 0 } })).rejects.toThrow(DB_REFUSAL);
    await expect(prisma.ledgerEntry.create({ data: { ...base, type: "CHARGE", amountCents: 5, voidedAt: new Date() } })).rejects.toThrow(/LedgerEntry_void_check/);
    await expect(prisma.customer.update({ where: { id }, data: { status: "bogus" } })).rejects.toThrow(DB_REFUSAL);
    await expect(prisma.customer.update({ where: { id }, data: { creditLimitCents: -1 } })).rejects.toThrow(DB_REFUSAL);
  });
});

describe("retries are safe (idempotency)", () => {
  test("the same payment submitted twice is recorded once, and the second answer says so", async () => {
    const id = await approvedCustomer("Retry Payment Co");
    await recordEntry(id, entry("CHARGE", 500_00), EMPLOYEE);
    const requestKey = randomUUID();

    const first = await recordEntry(id, entry("PAYMENT", 100_00, { requestKey }), EMPLOYEE);
    const second = await recordEntry(id, entry("PAYMENT", 100_00, { requestKey }), EMPLOYEE);

    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ id: first.id, duplicate: true });
    const detail = await getDetail(id, TODAY);
    expect(detail.ledger.filter((e) => e.type === "PAYMENT")).toHaveLength(1);
    expect(detail.customer.balanceCents).toBe(400_00);
  });

  test("two identical submissions arriving at the same moment still record once", async () => {
    const id = await approvedCustomer("Racing Retry Co");
    await recordEntry(id, entry("CHARGE", 500_00), EMPLOYEE);
    const requestKey = randomUUID();

    const [a, b] = await Promise.all([
      recordEntry(id, entry("PAYMENT", 50_00, { requestKey }), EMPLOYEE),
      recordEntry(id, entry("PAYMENT", 50_00, { requestKey }), EMPLOYEE),
    ]);

    expect(a.id).toBe(b.id);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(450_00);
  });

  test("a different key is a genuinely separate payment, even for the same amount", async () => {
    const id = await approvedCustomer("Two Real Payments Co");
    await recordEntry(id, entry("CHARGE", 500_00), EMPLOYEE);
    await recordEntry(id, entry("PAYMENT", 100_00, { requestKey: randomUUID() }), EMPLOYEE);
    await recordEntry(id, entry("PAYMENT", 100_00, { requestKey: randomUUID() }), EMPLOYEE);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(300_00);
  });

  test("the same key may be used by different customers (it is unique per customer)", async () => {
    const [one, two] = await Promise.all([approvedCustomer("Key Share One Co"), approvedCustomer("Key Share Two Co")]);
    const requestKey = randomUUID();
    await recordEntry(one, entry("CHARGE", 10_00, { requestKey }), EMPLOYEE);
    await recordEntry(two, entry("CHARGE", 10_00, { requestKey }), EMPLOYEE);
    expect((await getDetail(one, TODAY)).ledger).toHaveLength(1);
    expect((await getDetail(two, TODAY)).ledger).toHaveLength(1);
  });

  test("submitting a new application twice (a double click) creates one customer", async () => {
    const requestKey = randomUUID();
    const input = { ...profile("Double Click Co"), requestKey };
    const ids = await Promise.all([createCustomer(input, EMPLOYEE), createCustomer(input, EMPLOYEE)]);
    expect(ids[0]).toBe(ids[1]);
    expect(await prisma.customer.count({ where: { businessName: "Double Click Co" } })).toBe(1);
  });

  test("voiding an entry again, by the same person for the same reason, is a harmless retry", async () => {
    const id = await approvedCustomer("Retry Void Co");
    const { id: entryId } = await recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE);
    await voidEntry(id, entryId, "Entered twice", ADMIN);
    await voidEntry(id, entryId, "Entered twice", ADMIN);
    expect((await getDetail(id, TODAY)).audit.filter((e) => e.action === "ledger.void")).toHaveLength(1);
    // A different reason, or a different person, is a real conflict and is refused.
    await expectApiError(voidEntry(id, entryId, "A different reason", ADMIN), 409);
  });
});

describe("a busy database says so instead of hanging", () => {
  test("a write that cannot get the customer lock in time fails cleanly, with nothing saved", async () => {
    const id = await approvedCustomer("Busy Lock Co");
    await recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE);

    // Another writer holds the customer row for longer than the 10 second lock timeout.
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${id} FOR UPDATE`;
        await new Promise((resolve) => setTimeout(resolve, 13_000));
      },
      { timeout: 30_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    await expectApiError(recordEntry(id, entry("PAYMENT", 10_00), EMPLOYEE), 503);
    await holder;

    const detail = await getDetail(id, TODAY);
    expect(detail.ledger.filter((e) => e.type === "PAYMENT")).toHaveLength(0);
    // And the system is usable again straight away.
    await recordEntry(id, entry("PAYMENT", 10_00), EMPLOYEE);
  });
});

describe("permissions", () => {
  test("an employee cannot approve, deny or suspend", async () => {
    const id = await createCustomer(profile("Employee Decision Co"), EMPLOYEE);
    await expectApiError(decide(id, approval(1), EMPLOYEE), 403);
    await expectApiError(decide(id, { action: "deny", version: 1, reason: null }, EMPLOYEE), 403);
  });

  test("start_review cannot be used to undo a denial or a suspension", async () => {
    const denied = await createCustomer(profile("Denied Then Review Co"), EMPLOYEE);
    await decide(denied, { action: "deny", version: 1, reason: null }, ADMIN);
    await expectApiError(decide(denied, { action: "start_review", version: 2 }, EMPLOYEE), 409);
    expect((await getDetail(denied, TODAY)).customer.status).toBe("denied");

    const suspended = await approvedCustomer("Suspended Then Review Co");
    await decide(suspended, { action: "suspend", version: 2, reason: null }, ADMIN);
    await expectApiError(decide(suspended, { action: "start_review", version: 3 }, EMPLOYEE), 409);
    expect((await getDetail(suspended, TODAY)).customer.status).toBe("suspended");
  });

  test("an employee may start a review", async () => {
    const id = await createCustomer(profile("Start Review Co"), EMPLOYEE);
    await decide(id, { action: "start_review", version: 1 }, EMPLOYEE);
    expect((await getDetail(id, TODAY)).customer.status).toBe("under_review");
  });

  test("only an admin can change credit terms", async () => {
    const id = await approvedCustomer("Credit Terms Co");
    const current = (await getDetail(id, TODAY)).customer;
    const change = { ...profile("Credit Terms Co"), version: current.version, creditLimitCents: 99_000_00 };

    await expectApiError(updateCustomer(id, change, EMPLOYEE), 403);
    await updateCustomer(id, change, ADMIN);
    expect((await getDetail(id, TODAY)).customer.creditLimitCents).toBe(99_000_00);
  });

  test("credit terms cannot be set before approval", async () => {
    const id = await createCustomer(profile("Early Terms Co"), EMPLOYEE);
    await expectApiError(updateCustomer(id, { ...profile("Early Terms Co"), version: 1, creditLimitCents: 5_000_00 }, ADMIN), 409);
  });

  test("only an admin can post an adjustment", async () => {
    const id = await approvedCustomer("Adjust Co");
    await expectApiError(recordEntry(id, entry("ADJUSTMENT", 100), EMPLOYEE), 403);
    await recordEntry(id, entry("ADJUSTMENT", 100), ADMIN);
  });

  test("only an admin can void an entry (checked in the service, not just the route)", async () => {
    const id = await approvedCustomer("Void Permission Co");
    const { id: entryId } = await recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE);
    await expectApiError(voidEntry(id, entryId, "Because", EMPLOYEE), 403);
    await voidEntry(id, entryId, "Because", ADMIN);
  });
});

describe("workflow rules", () => {
  test("an approved decision cannot be repeated", async () => {
    const id = await approvedCustomer("Repeat Approval Co");
    await expectApiError(decide(id, approval(2), ADMIN), 409);
  });

  test("a stale decision is refused", async () => {
    const id = await createCustomer(profile("Stale Decision Co"), EMPLOYEE);
    await expectApiError(decide(id, approval(99), ADMIN), 409);
  });

  test("charges need an approved account; payments also work on a suspended one", async () => {
    const id = await createCustomer(profile("Pending Co"), EMPLOYEE);
    await expectApiError(recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE), 409);

    const active = await approvedCustomer("Suspend Co");
    await recordEntry(active, entry("CHARGE", 100_00), EMPLOYEE);
    await decide(active, { action: "suspend", version: 2, reason: "Late" }, ADMIN);

    await expectApiError(recordEntry(active, entry("CHARGE", 50_00), EMPLOYEE), 409);
    await recordEntry(active, entry("PAYMENT", 40_00), EMPLOYEE);
    expect((await getDetail(active, TODAY)).customer.balanceCents).toBe(60_00);
  });

  test("a reopened customer who still owes can still pay, and a decision restarts the review clock", async () => {
    const id = await approvedCustomer("Reopened Debtor Co");
    await recordEntry(id, entry("CHARGE", 300_00), EMPLOYEE);
    await decide(id, { action: "suspend", version: 2, reason: null }, ADMIN);
    await decide(id, { action: "reopen", version: 3 }, ADMIN);

    const reopened = (await getDetail(id, TODAY)).customer;
    expect(reopened.status).toBe("under_review");
    // The clock restarted at the reopening, not at the original application on 2026-10-01.
    expect(reopened.statusChangedDate).toBe(TODAY);

    await recordEntry(id, entry("PAYMENT", 100_00), EMPLOYEE);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(200_00);
  });

  test("a payment is refused where there is nothing owed and no history", async () => {
    const id = await createCustomer(profile("Nothing Owed Co"), EMPLOYEE);
    await expectApiError(recordEntry(id, entry("PAYMENT", 10_00), EMPLOYEE), 409);
  });

  test("a missing due date comes from the payment terms", async () => {
    const id = await approvedCustomer("Terms Due Date Co");
    await recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE);
    expect((await getDetail(id, TODAY)).ledger[0]?.dueDate).toBe(addDays(TODAY, 30));
  });

  test("warns when a charge passes the limit and when a payment exceeds the balance", async () => {
    const id = await approvedCustomer("Warning Co", 1_000_00);
    expect((await recordEntry(id, entry("CHARGE", 900_00), EMPLOYEE)).warning).toBeNull();
    expect((await recordEntry(id, entry("CHARGE", 200_00), EMPLOYEE)).warning).toBe("over_limit");
    expect((await recordEntry(id, entry("PAYMENT", 5_000_00), EMPLOYEE)).warning).toBe("overpayment");
    expect((await getDetail(id, TODAY)).customer.creditCents).toBe(3_900_00);
  });
});

describe("audit trail and derived figures", () => {
  test("every change writes an audit event naming who did it", async () => {
    const id = await approvedCustomer("Audit Co");
    await recordEntry(id, entry("CHARGE", 250_00), EMPLOYEE);
    const { audit } = await getDetail(id, TODAY);

    expect(audit.map((e) => e.action).sort()).toEqual(["customer.created", "decision.approve", "ledger.charge"]);
    expect(audit.find((e) => e.action === "ledger.charge")?.actor).toBe("Test Employee");
  });

  test("ledger rows record who made them by id, and each ledger audit event points at its entry", async () => {
    const id = await approvedCustomer("Attribution Co");
    const { id: entryId } = await recordEntry(id, entry("CHARGE", 25_00), EMPLOYEE);
    await voidEntry(id, entryId, "Wrong customer", ADMIN);

    const row = (await prisma.ledgerEntry.findUnique({ where: { id: entryId } }))!;
    expect(row).toMatchObject({ createdById: "u-emp", voidedById: "u-admin" });
    const events = await prisma.auditEvent.findMany({ where: { customerId: id, ledgerEntryId: entryId } });
    expect(events.map((e) => e.action).sort()).toEqual(["ledger.charge", "ledger.void"]);
  });

  test("an entry dated after the business day is kept and flagged, and not counted until then", async () => {
    const id = await approvedCustomer("Post Dated Co");
    const result = await recordEntry(id, entry("CHARGE", 80_00, { entryDate: AHEAD }), EMPLOYEE);
    expect(result.postDated).toBe(true);
    expect((await recordEntry(id, entry("CHARGE", 20_00), EMPLOYEE)).postDated).toBe(false);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(20_00);
  });

  test("aging is as-of the day asked for: a post-dated payment does not reduce today's overdue", async () => {
    const id = await approvedCustomer("As Of Co");
    await recordEntry(id, entry("CHARGE", 100_00, { entryDate: "2026-09-01", dueDate: "2026-10-01" }), ADMIN);
    await recordEntry(id, entry("PAYMENT", 100_00, { entryDate: "2026-10-20" }), ADMIN);

    expect((await getDetail(id, "2026-10-13")).customer).toMatchObject({ balanceCents: 100_00, overdueCents: 100_00 });
    expect((await getDetail(id, "2026-10-20")).customer).toMatchObject({ balanceCents: 0, overdueCents: 0 });
  });

  test("audit events carry the user's id, and entry details", async () => {
    const id = await approvedCustomer("Audit Detail Co");
    const { id: entryId } = await recordEntry(id, entry("ADJUSTMENT", -50_00, { reference: "CR-7" }), ADMIN);
    await voidEntry(id, entryId, "Wrong customer", ADMIN);

    const events = await prisma.auditEvent.findMany({ where: { customerId: id } });
    expect(events.every((e) => e.actorId !== null)).toBe(true);
    expect(events.find((e) => e.action === "ledger.adjustment")?.summary).toBe("Adjustment — −$50.00 (CR-7)");
    expect(events.find((e) => e.action === "ledger.void")?.summary).toBe("Voided adjustment of −$50.00 (CR-7) — Wrong customer");
  });

  test("an edit records exactly which fields changed", async () => {
    const id = await createCustomer(profile("Diff Co"), EMPLOYEE);
    await updateCustomer(id, { ...profile("Diff Co Renamed"), phone: "555-0100", version: 1 }, EMPLOYEE);
    const event = (await getDetail(id, TODAY)).audit.find((e) => e.action === "customer.updated");

    expect(event?.summary).toBe("Updated business name, phone");
    expect(event?.changes?.map((c) => c.field).sort()).toEqual(["businessName", "phone"]);
  });

  test("the summary list matches the detail view", async () => {
    const id = await approvedCustomer("Summary Co");
    await recordEntry(id, entry("CHARGE", 123_45, { dueDate: addDays(TODAY, -12) }), EMPLOYEE);

    const summary = (await listSummaries(TODAY)).find((c) => c.id === id);
    const detail = (await getDetail(id, TODAY)).customer;
    expect(summary).toEqual(detail);
    expect(summary).toMatchObject({ balanceCents: 123_45, overdueCents: 123_45, oldestOverdueDays: 12 });
  });
});

const reason = "Customer closed, uncollectible";
const writeOff = (amountCents: number, extra: object = {}) => entry("WRITE_OFF", amountCents, { note: reason, ...extra });
const reversal = (why = "Check bounced") => ({ reason: why });

describe("write-offs", () => {
  test("only an admin can write off a balance, and it reduces what is owed without counting as a payment", async () => {
    const id = await approvedCustomer("Write Off Co");
    await recordEntry(id, entry("CHARGE", 500_00), EMPLOYEE);
    await expectApiError(recordEntry(id, writeOff(100_00), EMPLOYEE), 403);

    await recordEntry(id, writeOff(200_00), ADMIN);
    const detail = await getDetail(id, TODAY);
    expect(detail.customer).toMatchObject({ balanceCents: 300_00, writtenOffCents: 200_00 });
    expect(detail.ledger.find((e) => e.type === "WRITE_OFF")).toMatchObject({ amountCents: 200_00, note: reason });
    // The history also says which charge the write-off covered.
    const summary = detail.audit.find((e) => e.action === "ledger.write_off")?.summary ?? "";
    expect(summary.startsWith(`Written off — $200.00 — ${reason} — covers a charge of $500.00 dated `)).toBe(true);
    expect(summary.endsWith("($200.00)")).toBe(true);
  });

  test("cannot write off more than is owed, or anything when nothing is owed, or on a future date", async () => {
    const id = await approvedCustomer("Write Off Limits Co");
    await expectApiError(recordEntry(id, writeOff(1_00), ADMIN), 409); // nothing owed yet
    await recordEntry(id, entry("CHARGE", 50_00), EMPLOYEE);
    await expectApiError(recordEntry(id, writeOff(50_01), ADMIN), 409);
    await expectApiError(recordEntry(id, writeOff(10_00, { entryDate: "2099-01-01" }), ADMIN), 422);

    await recordEntry(id, writeOff(50_00), ADMIN);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(0);
    await expectApiError(recordEntry(id, writeOff(1_00), ADMIN), 409);
  });

  test("the limit is what was owed on the write-off's own date, not what is owed today", async () => {
    const id = await approvedCustomer("Write Off As Of Co");
    await recordEntry(id, entry("CHARGE", 40_00, { entryDate: LAST_MONTH, dueDate: LAST_MONTH }), ADMIN);
    await recordEntry(id, entry("CHARGE", 60_00), EMPLOYEE);
    // 100.00 is owed today, but only 40.00 was owed on LAST_MONTH.
    await expectApiError(recordEntry(id, writeOff(41_00, { entryDate: LAST_MONTH }), ADMIN), 409);
    await recordEntry(id, writeOff(40_00, { entryDate: LAST_MONTH }), ADMIN);
  });

  test("it settles the oldest charge first, so what remains keeps its true age", async () => {
    const id = await approvedCustomer("Write Off Aging Co");
    await recordEntry(id, entry("CHARGE", 100_00, { entryDate: addDays(TODAY, -120), dueDate: addDays(TODAY, -90) }), ADMIN);
    await recordEntry(id, entry("CHARGE", 50_00, { entryDate: addDays(TODAY, -20), dueDate: addDays(TODAY, -5) }), ADMIN);
    await recordEntry(id, writeOff(100_00), ADMIN);

    const { customer } = await getDetail(id, TODAY);
    expect(customer.buckets.d90_plus).toBe(0);
    expect(customer).toMatchObject({ balanceCents: 50_00, overdueCents: 50_00, oldestOverdueDays: 5 });
  });

  test("the same write-off submitted twice is recorded once", async () => {
    const id = await approvedCustomer("Write Off Retry Co");
    await recordEntry(id, entry("CHARGE", 90_00), EMPLOYEE);
    const requestKey = randomUUID();
    const first = await recordEntry(id, writeOff(30_00, { requestKey }), ADMIN);
    const second = await recordEntry(id, writeOff(30_00, { requestKey }), ADMIN);
    expect(second).toMatchObject({ id: first.id, duplicate: true });
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(60_00);
  });

  test("works on a suspended account that still owes", async () => {
    const id = await approvedCustomer("Write Off Suspended Co");
    await recordEntry(id, entry("CHARGE", 70_00), EMPLOYEE);
    await decide(id, { action: "suspend", version: 2, reason: null }, ADMIN);
    await recordEntry(id, writeOff(70_00), ADMIN);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(0);
  });
});

describe("reversals", () => {
  test("only an admin can reverse", async () => {
    const id = await approvedCustomer("Reverse Role Co");
    const { id: entryId } = await recordEntry(id, entry("CHARGE", 25_00), EMPLOYEE);
    await expectApiError(reverseEntry(id, entryId, reversal(), EMPLOYEE), 403);
  });

  test("an entry from a closed month is reversed by a new entry dated today, and the closed month does not change", async () => {
    const id = await approvedCustomer("Reverse Closed Month Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 80_00, { entryDate: LAST_MONTH, dueDate: LAST_MONTH }), ADMIN);
    const before = (await getDetail(id, LAST_MONTH)).customer;

    const result = await reverseEntry(id, chargeId, reversal("Billed to the wrong customer"), ADMIN);
    expect(result.duplicate).toBe(false);

    const detail = await getDetail(id, TODAY);
    expect(detail.customer.balanceCents).toBe(0);
    const row = detail.ledger.find((e) => e.id === result.id);
    expect(row).toMatchObject({ type: "REVERSAL", amountCents: -80_00, entryDate: TODAY, reversesId: chargeId, note: "Billed to the wrong customer" });
    expect(detail.ledger.find((e) => e.id === chargeId)).toMatchObject({ reversed: true, voided: false });
    // The closed month still reads exactly as it did.
    const after = (await getDetail(id, LAST_MONTH)).customer;
    expect({ balance: after.balanceCents, overdue: after.overdueCents, buckets: after.buckets, writtenOff: after.writtenOffCents }).toEqual({
      balance: before.balanceCents,
      overdue: before.overdueCents,
      buckets: before.buckets,
      writtenOff: before.writtenOffCents,
    });
    expect(detail.audit.find((e) => e.action === "ledger.reversal")?.summary).toBe("Reversed charge of $80.00 — Billed to the wrong customer");
  });

  test("reversing a payment re-opens the debt it had paid", async () => {
    const id = await approvedCustomer("Reverse Payment Co");
    await recordEntry(id, entry("CHARGE", 100_00, { entryDate: LAST_MONTH, dueDate: LAST_MONTH }), ADMIN);
    const { id: paymentId } = await recordEntry(id, entry("PAYMENT", 100_00, { entryDate: LAST_MONTH }), ADMIN);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(0);

    await reverseEntry(id, paymentId, reversal("Check bounced"), ADMIN);
    const { customer } = await getDetail(id, TODAY);
    expect(customer.balanceCents).toBe(100_00);
    expect(customer.overdueCents).toBe(100_00);
  });

  test("reversing a write-off puts the debt back and takes it out of the written-off total", async () => {
    const id = await approvedCustomer("Reverse Write Off Co");
    await recordEntry(id, entry("CHARGE", 60_00), EMPLOYEE);
    const { id: writeOffId } = await recordEntry(id, writeOff(60_00), ADMIN);
    expect((await getDetail(id, TODAY)).customer).toMatchObject({ balanceCents: 0, writtenOffCents: 60_00 });

    await reverseEntry(id, writeOffId, reversal("Customer paid after all"), ADMIN);
    expect((await getDetail(id, TODAY)).customer).toMatchObject({ balanceCents: 60_00, writtenOffCents: 0 });
  });

  test("an entry can be reversed once: a repeat by the same person is a no-op, anything else is refused", async () => {
    const id = await approvedCustomer("Reverse Twice Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 15_00), EMPLOYEE);
    const first = await reverseEntry(id, chargeId, reversal("Entered twice"), ADMIN);
    const retry = await reverseEntry(id, chargeId, reversal("Entered twice"), ADMIN);
    expect(retry).toEqual({ id: first.id, duplicate: true });
    await expectApiError(reverseEntry(id, chargeId, reversal("A different reason"), ADMIN), 409);
    await expectApiError(reverseEntry(id, chargeId, reversal("Entered twice"), { ...ADMIN, id: "u-other", name: "Other Admin" }), 409);

    const detail = await getDetail(id, TODAY);
    expect(detail.ledger.filter((e) => e.type === "REVERSAL")).toHaveLength(1);
    expect(detail.audit.filter((e) => e.action === "ledger.reversal")).toHaveLength(1);
  });

  test("two admins reversing the same entry at once: exactly one reversal exists", async () => {
    const id = await approvedCustomer("Reverse Race Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 45_00), EMPLOYEE);
    const outcomes = await Promise.allSettled([
      reverseEntry(id, chargeId, reversal("Mine"), ADMIN),
      reverseEntry(id, chargeId, reversal("Mine too"), { ...ADMIN, id: "u-admin-2", name: "Second Admin" }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect((await getDetail(id, TODAY)).ledger.filter((e) => e.type === "REVERSAL")).toHaveLength(1);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(0);
  });

  test("the same form submitted twice (same request key) records one reversal", async () => {
    const id = await approvedCustomer("Reverse Key Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 12_00), EMPLOYEE);
    const requestKey = randomUUID();
    const first = await reverseEntry(id, chargeId, { reason: "Wrong job", requestKey }, ADMIN);
    const second = await reverseEntry(id, chargeId, { reason: "Wrong job", requestKey }, ADMIN);
    expect(second).toEqual({ id: first.id, duplicate: true });
  });

  test("a reversal cannot be reversed, and a voided entry has nothing to reverse", async () => {
    const id = await approvedCustomer("Reverse Limits Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 20_00), EMPLOYEE);
    const { id: reversalId } = await reverseEntry(id, chargeId, reversal(), ADMIN);
    await expectApiError(reverseEntry(id, reversalId, reversal("Undo the undo"), ADMIN), 409);

    const { id: other } = await recordEntry(id, entry("CHARGE", 5_00), EMPLOYEE);
    await voidEntry(id, other, "Typo", ADMIN);
    await expectApiError(reverseEntry(id, other, reversal(), ADMIN), 409);
    await expectApiError(reverseEntry(id, "no-such-entry", reversal(), ADMIN), 404);
  });

  test("a reversal of a future-dated entry is dated no earlier than that entry", async () => {
    const id = await approvedCustomer("Reverse Future Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 33_00, { entryDate: AHEAD }), EMPLOYEE);
    const result = await reverseEntry(id, chargeId, reversal(), ADMIN);
    expect((await getDetail(id, AHEAD)).ledger.find((e) => e.id === result.id)?.entryDate).toBe(AHEAD);
    expect((await getDetail(id, AHEAD)).customer.balanceCents).toBe(0);
  });
});

describe("voiding after reversals and month close", () => {
  test("this month's entries can still be voided; an entry from a closed month cannot, and says to reverse it", async () => {
    const id = await approvedCustomer("Void Window Co");
    const { id: oldId } = await recordEntry(id, entry("CHARGE", 10_00, { entryDate: LAST_MONTH, dueDate: LAST_MONTH }), ADMIN);
    const { id: newId } = await recordEntry(id, entry("CHARGE", 10_00), EMPLOYEE);

    await voidEntry(id, newId, "Typo", ADMIN);
    const error = await voidEntry(id, oldId, "Typo", ADMIN).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409, code: "closed_month" });
    expect(String((error as ApiError).message)).toContain("Reverse it instead");
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(10_00);
  });

  test("a reversed entry cannot also be voided (that would cancel it twice), and a reversal cannot be voided", async () => {
    const id = await approvedCustomer("Void After Reverse Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 40_00), EMPLOYEE);
    const { id: reversalId } = await reverseEntry(id, chargeId, reversal(), ADMIN);

    await expectApiError(voidEntry(id, chargeId, "Typo", ADMIN), 409);
    await expectApiError(voidEntry(id, reversalId, "Typo", ADMIN), 409);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(0);
  });
});

describe("the database itself protects write-offs and reversals", () => {
  const base = (customerId: string) => ({ customerId, entryDate: new Date(`${TODAY}T00:00:00Z`), createdBy: "raw" });

  test("a write-off or reversal without a reason is refused", async () => {
    const id = await approvedCustomer("Raw Reason Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 10_00), EMPLOYEE);
    await expect(prisma.ledgerEntry.create({ data: { ...base(id), type: "WRITE_OFF", amountCents: 5_00 } })).rejects.toThrow(DB_REFUSAL);
    await expect(prisma.ledgerEntry.create({ data: { ...base(id), type: "WRITE_OFF", amountCents: 5_00, note: "  " } })).rejects.toThrow(DB_REFUSAL);
    await expect(
      prisma.ledgerEntry.create({ data: { ...base(id), type: "REVERSAL", amountCents: -10_00, reversesEntryId: chargeId } }),
    ).rejects.toThrow(DB_REFUSAL);
  });

  test("only a reversal may name an entry it reverses, and a write-off must be positive", async () => {
    const id = await approvedCustomer("Raw Shape Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 10_00), EMPLOYEE);
    await expect(prisma.ledgerEntry.create({ data: { ...base(id), type: "REVERSAL", amountCents: -10_00, note: "Because" } })).rejects.toThrow(DB_REFUSAL);
    await expect(
      prisma.ledgerEntry.create({ data: { ...base(id), type: "CHARGE", amountCents: 5, reversesEntryId: chargeId } }),
    ).rejects.toThrow(DB_REFUSAL);
    await expect(prisma.ledgerEntry.create({ data: { ...base(id), type: "WRITE_OFF", amountCents: -5_00, note: "Because" } })).rejects.toThrow(DB_REFUSAL);
    await expect(prisma.ledgerEntry.create({ data: { ...base(id), type: "REVERSAL", amountCents: 0, note: "Because", reversesEntryId: chargeId } })).rejects.toThrow(DB_REFUSAL);
  });

  test("an entry cannot be reversed twice, and what a reversal points at cannot be changed", async () => {
    const id = await approvedCustomer("Raw Twice Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 10_00), EMPLOYEE);
    const { id: other } = await recordEntry(id, entry("CHARGE", 20_00), EMPLOYEE);
    const { id: reversalId } = await reverseEntry(id, chargeId, reversal(), ADMIN);

    await expect(
      prisma.ledgerEntry.create({ data: { ...base(id), type: "REVERSAL", amountCents: -10_00, note: "Again", reversesEntryId: chargeId } }),
    ).rejects.toThrow(DB_REFUSAL);
    await expect(prisma.ledgerEntry.update({ where: { id: reversalId }, data: { reversesEntryId: other } })).rejects.toThrow(DB_REFUSAL);
  });
});
