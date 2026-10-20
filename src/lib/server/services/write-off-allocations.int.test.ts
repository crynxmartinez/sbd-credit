import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import { addDays } from "@/lib/domain/dates";
import { computeAging, type LedgerRecord } from "@/lib/domain/ledger";
import { prisma } from "@/lib/server/db";
import { ApiError } from "@/lib/server/http";
import type { SessionUser } from "@/lib/types";
import type { CustomerCreateInput } from "@/lib/validation";
import { businessToday } from "../as-of";
import { createCustomer, decide, getDetail } from "./customers";
import { ledgerCsv } from "./exports";
import { recordEntry, reverseEntry, voidEntry } from "./ledger";
import { DB_REFUSAL } from "./db-refusal";

/**
 * A write-off names the charges it covers. These tests run against the real database: the rules the service enforces, the
 * rules the database enforces on its own, and the migration's backfill of write-offs that were recorded before allocations existed.
 */
const ADMIN: SessionUser = { id: "u-admin", username: "admin", name: "Test Admin", role: "ADMIN" };
const EMPLOYEE: SessionUser = { id: "u-emp", username: "emp", name: "Test Employee", role: "EMPLOYEE" };
const TODAY = businessToday();
const LAST_MONTH = addDays(`${TODAY.slice(0, 8)}01`, -1);

const profile = (name: string): CustomerCreateInput => ({
  businessName: name, contactName: null, phone: null, email: null, billingAddress: null, dateApplied: "2026-10-01",
  requestedLimitCents: null, accountingAppName: null, accountingProjectUrl: null, notes: null,
});

async function approvedCustomer(name: string): Promise<string> {
  const id = await createCustomer(profile(name), EMPLOYEE);
  await decide(id, { action: "approve", version: 1, creditLimitCents: 100_000_00, paymentTerms: "Net 30", creditStartDate: "2026-10-01" }, ADMIN);
  return id;
}

const entry = (type: "CHARGE" | "PAYMENT" | "WRITE_OFF", amountCents: number, extra: object = {}) => ({
  type, amountCents, entryDate: TODAY, dueDate: null, reference: null, note: null, ...extra,
});
const charge = (id: string, cents: number, reference: string, extra: object = {}) => recordEntry(id, entry("CHARGE", cents, { reference, ...extra }), ADMIN);
const writeOff = (id: string, cents: number, extra: object = {}) => recordEntry(id, entry("WRITE_OFF", cents, { note: "Uncollectible", ...extra }), ADMIN);

async function expectApiError(promise: Promise<unknown>, status: number, code?: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
  if (code) expect((error as ApiError).code).toBe(code);
}

const allocationsOf = async (writeOffId: string) =>
  (await prisma.writeOffAllocation.findMany({ where: { writeOffEntryId: writeOffId }, orderBy: { chargeEntryId: "asc" } })).map((row) => ({ chargeEntryId: row.chargeEntryId, amountCents: row.amountCents }));

beforeAll(async () => {
  expect(new URL(process.env.DATABASE_URL ?? "").searchParams.get("schema")).toMatch(/^credit_test/);
  await prisma.$queryRaw`SELECT 1`;
});

describe("a write-off is allocated to specific charges", () => {
  test("by default the oldest-due charge is covered first, then the next, and the amounts add up to the write-off", async () => {
    const id = await approvedCustomer("Default Allocation Co");
    const newer = await charge(id, 80_00, "INV-NEW", { entryDate: LAST_MONTH, dueDate: addDays(LAST_MONTH, 20) });
    const older = await charge(id, 60_00, "INV-OLD", { entryDate: LAST_MONTH, dueDate: addDays(LAST_MONTH, 5) });
    const { id: writeOffId } = await writeOff(id, 100_00);

    const split = await allocationsOf(writeOffId);
    expect(split.reduce((sum, row) => sum + row.amountCents, 0)).toBe(100_00);
    expect(split).toEqual(expect.arrayContaining([{ chargeEntryId: older.id, amountCents: 60_00 }, { chargeEntryId: newer.id, amountCents: 40_00 }]));
    expect(split).toHaveLength(2);
    expect(await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: writeOffId } })).toMatchObject({ allocationsRequired: true });
  });

  test("an explicit choice is honoured: the chosen charge is covered and the other stays open with its true age", async () => {
    const id = await approvedCustomer("Chosen Allocation Co");
    const older = await charge(id, 50_00, "INV-A", { entryDate: LAST_MONTH, dueDate: addDays(LAST_MONTH, 5) });
    const newer = await charge(id, 50_00, "INV-B", { entryDate: LAST_MONTH, dueDate: addDays(LAST_MONTH, 25) });
    const { id: writeOffId } = await writeOff(id, 50_00, { allocations: [{ chargeId: newer.id, amountCents: 50_00 }] });

    expect(await allocationsOf(writeOffId)).toEqual([{ chargeEntryId: newer.id, amountCents: 50_00 }]);
    const { aging } = await getDetail(id, TODAY);
    expect(aging.openItems).toEqual([expect.objectContaining({ id: older.id, remainingCents: 50_00 })]);
    // Because the older charge is NOT covered, it can still be corrected.
    await voidEntry(id, older.id, "Typo", ADMIN).catch(() => reverseEntry(id, older.id, { reason: "Typo" }, ADMIN));
  });

  test("a bad choice is refused: unknown charge, more than is open, amounts that do not add up, a duplicate", async () => {
    const id = await approvedCustomer("Bad Choice Co");
    const a = await charge(id, 50_00, "INV-A");
    const b = await charge(id, 20_00, "INV-B");
    const attempt = (amountCents: number, allocations: Array<{ chargeId: string; amountCents: number }>) => writeOff(id, amountCents, { allocations });
    await expectApiError(attempt(10_00, [{ chargeId: "no-such-charge", amountCents: 10_00 }]), 409, "invalid_allocation");
    await expectApiError(attempt(30_00, [{ chargeId: b.id, amountCents: 30_00 }]), 409, "invalid_allocation"); // only 20 open on B
    await expectApiError(attempt(30_00, [{ chargeId: a.id, amountCents: 10_00 }, { chargeId: b.id, amountCents: 10_00 }]), 409, "invalid_allocation"); // 20 of 30
    await expectApiError(attempt(20_00, [{ chargeId: a.id, amountCents: 10_00 }, { chargeId: a.id, amountCents: 10_00 }]), 409, "invalid_allocation");
    expect((await getDetail(id, TODAY)).customer.writtenOffCents).toBe(0);
  });

  test("only charges are covered: a payment is not a target, and an employee cannot write off at all", async () => {
    const id = await approvedCustomer("Targets Co");
    await charge(id, 50_00, "INV-A");
    const payment = await recordEntry(id, entry("PAYMENT", 10_00), EMPLOYEE);
    await expectApiError(writeOff(id, 5_00, { allocations: [{ chargeId: payment.id, amountCents: 5_00 }] }), 409, "invalid_allocation");
    await expectApiError(recordEntry(id, entry("WRITE_OFF", 5_00, { note: "Uncollectible" }), EMPLOYEE), 403);
  });

  test("more than is open is refused with the most that can be written off", async () => {
    const id = await approvedCustomer("Too Much Co");
    await charge(id, 40_00, "INV-A");
    await expectApiError(writeOff(id, 40_01), 409, "exceeds_balance");
    await expectApiError(writeOff(await approvedCustomer("Nothing Owed Co"), 1_00), 409, "nothing_owed");
  });

  test("the history says which charges were covered, and so does the CSV export", async () => {
    const id = await approvedCustomer("Described Co");
    await charge(id, 60_00, "INV-1001");
    await writeOff(id, 60_00);
    const detail = await getDetail(id, TODAY);
    expect(detail.audit.find((event) => event.action === "ledger.write_off")?.summary).toContain("covers INV-1001 ($60.00)");
    const rows = (await ledgerCsv(TODAY)).split("\r\n").filter((line) => line.startsWith(`${id},`) && line.includes("WRITE_OFF"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("INV-1001 ($60.00)");
  });

  test("the detail tells the screen what covers what, so it can offer exactly what the server accepts", async () => {
    const id = await approvedCustomer("Detail Co");
    const c = await charge(id, 60_00, "INV-D");
    const { id: writeOffId } = await writeOff(id, 25_00);
    const { ledger } = await getDetail(id, TODAY);
    expect(ledger.find((row) => row.id === writeOffId)?.covers).toEqual([{ chargeId: c.id, amountCents: 25_00 }]);
    expect(ledger.find((row) => row.id === c.id)).toMatchObject({ writtenOffCents: 25_00, everWrittenOff: true });
  });
});

describe("correcting a charge", () => {
  test("a charge a write-off covers cannot be voided or reversed; a charge nothing covers always can, even on the same day", async () => {
    const id = await approvedCustomer("Same Day Co");
    const first = await charge(id, 100_00, "INV-1", { dueDate: addDays(TODAY, 10) });
    const second = await charge(id, 100_00, "INV-2", { dueDate: addDays(TODAY, 40) });
    const { id: writeOffId } = await writeOff(id, 100_00); // covers the earlier-due one

    await expectApiError(voidEntry(id, first.id, "Typo", ADMIN), 409, "write_off_covers");
    await expectApiError(reverseEntry(id, first.id, { reason: "Wrong customer" }, ADMIN), 409, "write_off_covers");
    await voidEntry(id, second.id, "Typo", ADMIN); // same day, same amount, but nothing covers it

    // Reversing the write-off frees the first charge; it can then be reversed (not voided: it was covered once).
    await reverseEntry(id, writeOffId, { reason: "Collected after all" }, ADMIN);
    await expectApiError(voidEntry(id, first.id, "Typo", ADMIN), 409, "write_off_history");
    await reverseEntry(id, first.id, { reason: "Wrong customer" }, ADMIN);
  });

  test("the message names the write-off that covers the charge", async () => {
    const id = await approvedCustomer("Named Co");
    const c = await charge(id, 70_00, "INV-N");
    await writeOff(id, 70_00);
    const error = await voidEntry(id, c.id, "Typo", ADMIN).then(() => null, (caught: unknown) => caught);
    expect((error as ApiError).message).toMatch(/write-off of \$70\.00 dated/);
  });

  test("a voided write-off leaves no trace: its charge can be voided again", async () => {
    const id = await approvedCustomer("Voided Write Off Co");
    const c = await charge(id, 70_00, "INV-V");
    const { id: writeOffId } = await writeOff(id, 70_00);
    await voidEntry(id, writeOffId, "Entered by mistake", ADMIN);
    await voidEntry(id, c.id, "Typo", ADMIN);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(0);
  });
});

describe("a write-off is judged on every day it would be in force", () => {
  test("a write-off backdated over a time another write-off was in force is refused, even though the first was reversed since", async () => {
    const id = await approvedCustomer("Overlap Co");
    const c = await charge(id, 100_00, "INV-O", { entryDate: LAST_MONTH, dueDate: LAST_MONTH });
    const first = await writeOff(id, 100_00, { entryDate: LAST_MONTH });
    await reverseEntry(id, first.id, { reason: "Collected" }, ADMIN); // reversal dated TODAY

    // Dated last month it would overlap the first one (in force from last month until today): the charge would be settled twice.
    await expectApiError(writeOff(id, 100_00, { entryDate: LAST_MONTH }), 409);
    // Dated today there is no overlap.
    const second = await writeOff(id, 100_00);
    expect(await allocationsOf(second.id)).toEqual([{ chargeEntryId: c.id, amountCents: 100_00 }]);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(0);
  });

  test("the same write-off request sent again is recorded once; sent with different charges it is refused", async () => {
    const id = await approvedCustomer("Retry Co");
    const a = await charge(id, 50_00, "INV-A", { dueDate: addDays(TODAY, 5) });
    const b = await charge(id, 50_00, "INV-B", { dueDate: addDays(TODAY, 25) });
    const key = randomUUID();
    const first = await writeOff(id, 50_00, { requestKey: key, allocations: [{ chargeId: a.id, amountCents: 50_00 }] });
    const again = await writeOff(id, 50_00, { requestKey: key, allocations: [{ chargeId: a.id, amountCents: 50_00 }] });
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    await expectApiError(writeOff(id, 50_00, { requestKey: key, allocations: [{ chargeId: b.id, amountCents: 50_00 }] }), 409, "request_key_reuse");
  });
});

describe("the database refuses what the rules forbid, whatever the application does", () => {
  async function chargeAndWriteOff(name: string) {
    const id = await approvedCustomer(name);
    const c = await charge(id, 100_00, "INV-DB");
    const w = await writeOff(id, 40_00);
    return { id, chargeId: c.id, writeOffId: w.id };
  }

  test("allocations are append-only: no update, no delete", async () => {
    const { writeOffId } = await chargeAndWriteOff("Append Only Co");
    const row = await prisma.writeOffAllocation.findFirstOrThrow({ where: { writeOffEntryId: writeOffId } });
    await expect(prisma.writeOffAllocation.update({ where: { id: row.id }, data: { amountCents: 1 } })).rejects.toThrow(DB_REFUSAL);
    await expect(prisma.writeOffAllocation.delete({ where: { id: row.id } })).rejects.toThrow(DB_REFUSAL);
    await expect(prisma.$executeRaw`TRUNCATE "WriteOffAllocation"`).rejects.toThrow(DB_REFUSAL);
  });

  test("an allocation must point at a write-off and a charge of the same customer, and never add up to more than the write-off", async () => {
    const one = await chargeAndWriteOff("Rules One Co");
    const two = await chargeAndWriteOff("Rules Two Co");
    // the charge of another customer
    await expect(prisma.writeOffAllocation.create({ data: { writeOffEntryId: one.writeOffId, chargeEntryId: two.chargeId, amountCents: 1 } })).rejects.toThrow(/same customer/);
    // something that is not a charge (a payment)
    const payment = await recordEntry(one.id, entry("PAYMENT", 5_00), EMPLOYEE);
    await expect(prisma.writeOffAllocation.create({ data: { writeOffEntryId: one.writeOffId, chargeEntryId: payment.id, amountCents: 1 } })).rejects.toThrow(/charge/);
    // an allocation whose "write-off" is not one
    await expect(prisma.writeOffAllocation.create({ data: { writeOffEntryId: one.chargeId, chargeEntryId: one.chargeId, amountCents: 1 } })).rejects.toThrow(/write-offs only/);
    // more than the write-off (it already allocates all 40.00)
    const another = await charge(one.id, 100_00, "INV-MORE");
    await expect(prisma.writeOffAllocation.create({ data: { writeOffEntryId: one.writeOffId, chargeEntryId: another.id, amountCents: 1 } })).rejects.toThrow(/more than the write-off/);
    // an amount that is not positive
    await expect(prisma.writeOffAllocation.create({ data: { writeOffEntryId: one.writeOffId, chargeEntryId: another.id, amountCents: 0 } })).rejects.toThrow(DB_REFUSAL);
  });

  test("a charge dated after the write-off cannot be covered by it", async () => {
    const id = await approvedCustomer("Later Charge Co");
    await charge(id, 100_00, "INV-EARLY", { entryDate: LAST_MONTH, dueDate: LAST_MONTH });
    const w = await writeOff(id, 10_00, { entryDate: LAST_MONTH });
    const later = await charge(id, 100_00, "INV-LATE");
    await expect(prisma.writeOffAllocation.create({ data: { writeOffEntryId: w.id, chargeEntryId: later.id, amountCents: 1 } })).rejects.toThrow(/dated after/);
  });

  test("a write-off recorded as requiring allocations, with none, cannot be committed", async () => {
    const id = await approvedCustomer("Unallocated Co");
    await charge(id, 100_00, "INV-X");
    await expect(
      prisma.ledgerEntry.create({
        data: { customerId: id, type: "WRITE_OFF", amountCents: 10_00, entryDate: new Date(`${TODAY}T00:00:00Z`), note: "Uncollectible", createdBy: "t", allocationsRequired: true },
      }),
    ).rejects.toThrow(/allocated to charges in full/);
  });

  test("the flag is frozen: it cannot be switched off afterwards", async () => {
    const { writeOffId } = await chargeAndWriteOff("Frozen Flag Co");
    await expect(prisma.ledgerEntry.update({ where: { id: writeOffId }, data: { allocationsRequired: false } })).rejects.toThrow(DB_REFUSAL);
  });
});

describe("the migration's backfill of write-offs recorded before allocations existed", () => {
  /** A legacy write-off: in the ledger, with no allocations and not flagged, exactly as old data looks. */
  async function legacyWriteOff(customerId: string, amountCents: number, entryDate: string, extra: { voided?: boolean } = {}) {
    return prisma.ledgerEntry.create({
      data: {
        customerId, type: "WRITE_OFF", amountCents, entryDate: new Date(`${entryDate}T00:00:00Z`), note: "Uncollectible", createdBy: "legacy",
        allocationsRequired: false, ...(extra.voided ? { voidedAt: new Date(), voidedBy: "t", voidReason: "mistake" } : {}),
      },
    });
  }
  const backfill = async () => Number((await prisma.$queryRaw<{ n: number }[]>`SELECT credit_backfill_write_off_allocations() AS n`)[0]!.n);

  async function recordsOf(customerId: string): Promise<LedgerRecord[]> {
    const rows = await prisma.ledgerEntry.findMany({ where: { customerId, voidedAt: null }, include: { writeOffAllocations: true } });
    return rows.map((row) => ({
      id: row.id, type: row.type as LedgerRecord["type"], amountCents: row.amountCents, entryDate: row.entryDate.toISOString().slice(0, 10),
      dueDate: row.dueDate ? row.dueDate.toISOString().slice(0, 10) : null, voided: false, reverses: row.reversesEntryId,
      writeOffAllocations: row.writeOffAllocations.map((a) => ({ chargeId: a.chargeEntryId, amountCents: a.amountCents })),
    }));
  }

  test("allocates oldest-due-first, and nothing about what is owed or how old it is changes", async () => {
    const id = await approvedCustomer("Backfill Co");
    const a = await charge(id, 100_00, "INV-A", { entryDate: LAST_MONTH, dueDate: addDays(LAST_MONTH, 5) });
    await charge(id, 100_00, "INV-B", { entryDate: LAST_MONTH, dueDate: addDays(LAST_MONTH, 25) });
    await recordEntry(id, entry("PAYMENT", 30_00), EMPLOYEE);
    const legacy = await legacyWriteOff(id, 120_00, TODAY);

    const before = computeAging(await recordsOf(id), TODAY);
    expect(await backfill()).toBeGreaterThanOrEqual(1);
    const split = await allocationsOf(legacy.id);
    expect(split.reduce((sum, row) => sum + row.amountCents, 0)).toBe(120_00);
    expect(split.find((row) => row.chargeEntryId === a.id)?.amountCents).toBe(70_00); // the older charge had 70 open after the payment

    const after = computeAging(await recordsOf(id), TODAY);
    expect(after.balanceCents).toBe(before.balanceCents);
    expect(after.openItems).toEqual(before.openItems);
    expect(after.buckets).toEqual(before.buckets);
  });

  test("is safe to run again, and ignores voided and reversed write-offs", async () => {
    const id = await approvedCustomer("Backfill Twice Co");
    await charge(id, 100_00, "INV-A", { entryDate: LAST_MONTH, dueDate: LAST_MONTH });
    const live = await legacyWriteOff(id, 40_00, TODAY);
    const voided = await legacyWriteOff(id, 10_00, TODAY, { voided: true });
    await backfill();
    expect(await allocationsOf(live.id)).toHaveLength(1);
    expect(await allocationsOf(voided.id)).toEqual([]);
    const first = await prisma.writeOffAllocation.count({ where: { writeOffEntryId: live.id } });
    await backfill();
    expect(await prisma.writeOffAllocation.count({ where: { writeOffEntryId: live.id } })).toBe(first);
  });

  test("when later payments over-paid the charges, the write-off is placed on their remaining room and balances still agree", async () => {
    const id = await approvedCustomer("Backfill Overpaid Co");
    const a = await charge(id, 100_00, "INV-A", { entryDate: LAST_MONTH, dueDate: LAST_MONTH });
    const legacy = await legacyWriteOff(id, 60_00, LAST_MONTH);
    await recordEntry(id, entry("PAYMENT", 80_00), EMPLOYEE); // 60 + 80 > 100: the customer has overpaid

    const before = computeAging(await recordsOf(id), TODAY);
    await backfill();
    expect(await allocationsOf(legacy.id)).toEqual([{ chargeEntryId: a.id, amountCents: 60_00 }]);
    const after = computeAging(await recordsOf(id), TODAY);
    expect(after.balanceCents).toBe(before.balanceCents);
    expect(after.balanceCents).toBe(-40_00);
  });

  test("a write-off that cannot be allocated at all is left as it was, so nothing is lost or invented", async () => {
    const id = await approvedCustomer("Backfill Impossible Co");
    await charge(id, 10_00, "INV-A", { entryDate: LAST_MONTH, dueDate: LAST_MONTH });
    const legacy = await legacyWriteOff(id, 50_00, TODAY); // more than there ever was
    const before = computeAging(await recordsOf(id), TODAY);
    await backfill();
    expect(await allocationsOf(legacy.id)).toEqual([]);
    expect(computeAging(await recordsOf(id), TODAY).balanceCents).toBe(before.balanceCents);
    // Leave nothing behind that later runs (and the restore drill, which uses this schema in CI) would trip over.
    await prisma.ledgerEntry.update({ where: { id: legacy.id }, data: { voidedAt: new Date(), voidedBy: "test", voidReason: "cleanup" } });
  });
});
