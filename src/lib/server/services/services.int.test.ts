import { beforeAll, describe, expect, test } from "vitest";
import { ApiError } from "@/lib/server/http";
import { prisma } from "@/lib/server/db";
import type { SessionUser } from "@/lib/types";
import type { CustomerCreateInput, DecisionInput } from "@/lib/validation";
import { randomUUID } from "node:crypto";
import { createCustomer, decide, getDetail, listSummaries, updateCustomer } from "./customers";
import { recordEntry, voidEntry } from "./ledger";

const ADMIN: SessionUser = { id: "u-admin", username: "admin", name: "Test Admin", role: "ADMIN" };
const EMPLOYEE: SessionUser = { id: "u-emp", username: "emp", name: "Test Employee", role: "EMPLOYEE" };
const TODAY = "2026-10-13";

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

const entry = (type: "CHARGE" | "PAYMENT" | "ADJUSTMENT", amountCents: number, extra: object = {}) => ({
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
  test("a charge racing a suspension never lands on the suspended account", async () => {
    const id = await approvedCustomer("Charge Vs Suspend Co");
    await recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE);

    const [chargeResult, suspendResult] = await Promise.allSettled([
      recordEntry(id, entry("CHARGE", 50_00), EMPLOYEE),
      decide(id, { action: "suspend", version: 2, reason: "Race" }, ADMIN),
    ]);
    expect(suspendResult.status).toBe("fulfilled");

    const suspended = (await prisma.auditEvent.findFirst({ where: { customerId: id, action: "decision.suspend" } }))!;
    const charges = await prisma.ledgerEntry.findMany({ where: { customerId: id, type: "CHARGE" } });

    // Whichever won the race, no charge may have been created after the suspension took effect.
    for (const charge of charges) expect(charge.createdAt.getTime()).toBeLessThanOrEqual(suspended.createdAt.getTime());
    if (chargeResult.status === "rejected") expect((chargeResult.reason as ApiError).status).toBe(409);
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
    await expect(prisma.ledgerEntry.create({ data: base })).rejects.toThrow();
  });

  test("a void is the one allowed change, and it cannot be undone", async () => {
    const id = await approvedCustomer("Void Only Co");
    const { id: entryId } = await recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE);
    await voidEntry(id, entryId, "Entered twice", ADMIN);

    await expect(prisma.ledgerEntry.update({ where: { id: entryId }, data: { voidedAt: null, voidedBy: null, voidReason: null } })).rejects.toThrow();
  });

  test("bad data is refused whatever wrote it", async () => {
    const id = await approvedCustomer("Constraint Co");
    const base = { customerId: id, entryDate: new Date("2026-10-13T00:00:00Z"), createdBy: "raw" };

    await expect(prisma.ledgerEntry.create({ data: { ...base, type: "PAYMENT", amountCents: -5 } })).rejects.toThrow();
    await expect(prisma.ledgerEntry.create({ data: { ...base, type: "CHARGE", amountCents: 0 } })).rejects.toThrow();
    await expect(prisma.ledgerEntry.create({ data: { ...base, type: "REFUND", amountCents: 5 } })).rejects.toThrow();
    await expect(prisma.ledgerEntry.create({ data: { ...base, type: "ADJUSTMENT", amountCents: 0 } })).rejects.toThrow();
    await expect(prisma.ledgerEntry.create({ data: { ...base, type: "CHARGE", amountCents: 5, voidedAt: new Date() } })).rejects.toThrow();
    await expect(prisma.customer.update({ where: { id }, data: { status: "bogus" } })).rejects.toThrow();
    await expect(prisma.customer.update({ where: { id }, data: { creditLimitCents: -1 } })).rejects.toThrow();
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
    await expectApiError(updateCustomer(id, { ...profile("Early Terms Co"), version: 1, creditLimitCents: 5_000_00 }, ADMIN), 400);
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
    expect(reopened.statusChangedDate).not.toBe("2026-10-01");

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
    expect((await getDetail(id, TODAY)).ledger[0]?.dueDate).toBe("2026-11-12");
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
    const result = await recordEntry(id, entry("CHARGE", 80_00, { entryDate: "2099-01-01" }), EMPLOYEE);
    expect(result.postDated).toBe(true);
    expect((await recordEntry(id, entry("CHARGE", 20_00), EMPLOYEE)).postDated).toBe(false);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(20_00);
  });

  test("aging is as-of the day asked for: a post-dated payment does not reduce today's overdue", async () => {
    const id = await approvedCustomer("As Of Co");
    await recordEntry(id, entry("CHARGE", 100_00, { entryDate: "2026-09-01", dueDate: "2026-10-01" }), EMPLOYEE);
    await recordEntry(id, entry("PAYMENT", 100_00, { entryDate: "2026-10-20" }), EMPLOYEE);

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
    await recordEntry(id, entry("CHARGE", 123_45, { dueDate: "2026-10-01" }), EMPLOYEE);

    const summary = (await listSummaries(TODAY)).find((c) => c.id === id);
    const detail = (await getDetail(id, TODAY)).customer;
    expect(summary).toEqual(detail);
    expect(summary).toMatchObject({ balanceCents: 123_45, overdueCents: 123_45, oldestOverdueDays: 12 });
  });
});
