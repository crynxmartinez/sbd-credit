import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import { LEDGER_TYPES, MAX_POSTDATE_DAYS, type LedgerType } from "@/lib/domain/constants";
import { addDays } from "@/lib/domain/dates";
import { LEDGER_CSV_HEADER } from "@/lib/domain/ledger-csv";
import { balanceCents, type LedgerRecord } from "@/lib/domain/ledger";
import { prisma } from "@/lib/server/db";
import { ApiError } from "@/lib/server/http";
import type { SessionUser } from "@/lib/types";
import type { CustomerCreateInput } from "@/lib/validation";
import { businessToday } from "../as-of";
import type { Clock } from "../clock";
import { createCustomer, decide, getDetail, updateCustomer } from "./customers";
import { customersCsv, ledgerCsv } from "./exports";
import { balanceOf, recordEntry, reverseEntry, voidEntry } from "./ledger";

/**
 * The money rules added after the audit: what a write-off may cover, who may backdate, how far ahead an entry may be dated,
 * what a reused request key means, and that the SQL balance and the TypeScript balance agree for every kind of entry.
 */
const ADMIN: SessionUser = { id: "u-admin", username: "admin", name: "Test Admin", role: "ADMIN" };
const EMPLOYEE: SessionUser = { id: "u-emp", username: "emp", name: "Test Employee", role: "EMPLOYEE" };
const TODAY = businessToday();
const LAST_MONTH = addDays(`${TODAY.slice(0, 8)}01`, -1);

const profile = (name: string): CustomerCreateInput => ({
  businessName: name, contactName: null, phone: null, email: null, billingAddress: null, dateApplied: "2026-10-01",
  requestedLimitCents: null, accountingAppName: null, accountingProjectUrl: null, notes: null,
});

async function approvedCustomer(name: string, limitCents = 10_000_00): Promise<string> {
  const id = await createCustomer(profile(name), EMPLOYEE);
  await decide(id, { action: "approve", version: 1, creditLimitCents: limitCents, paymentTerms: "Net 30", creditStartDate: "2026-10-01" }, ADMIN);
  return id;
}

const entry = (type: "CHARGE" | "PAYMENT" | "ADJUSTMENT" | "WRITE_OFF", amountCents: number, extra: object = {}) => ({
  type, amountCents, entryDate: TODAY, dueDate: null, reference: null, note: null, ...extra,
});
const writeOff = (amountCents: number, extra: object = {}) => entry("WRITE_OFF", amountCents, { note: "Uncollectible", ...extra });

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

describe("a write-off must be covered by what is owed", () => {
  test("a write-off backdated to before the customer paid is refused, instead of leaving a negative balance", async () => {
    const id = await approvedCustomer("Backdated Write Off Co");
    await recordEntry(id, entry("CHARGE", 100_00, { entryDate: LAST_MONTH, dueDate: LAST_MONTH }), ADMIN);
    await recordEntry(id, entry("PAYMENT", 100_00), EMPLOYEE);

    // As of last month $100 was owed; today nothing is. Writing it off now would double-count the payment.
    await expectApiError(recordEntry(id, writeOff(100_00, { entryDate: LAST_MONTH }), ADMIN), 409);
    const { customer } = await getDetail(id, TODAY);
    expect(customer).toMatchObject({ balanceCents: 0, writtenOffCents: 0, availableCents: 10_000_00 });
  });

  test("a charge that a write-off covers cannot be voided or reversed until the write-off is reversed", async () => {
    const id = await approvedCustomer("Covered Charge Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE);
    const { id: writeOffId } = await recordEntry(id, writeOff(100_00), ADMIN);

    await expectApiError(voidEntry(id, chargeId, "Typo", ADMIN), 409, "write_off_covers");
    await expectApiError(reverseEntry(id, chargeId, { reason: "Wrong customer" }, ADMIN), 409, "write_off_covers");
    expect((await getDetail(id, TODAY)).customer).toMatchObject({ balanceCents: 0, writtenOffCents: 100_00 });

    // The order that works: undo the write-off first, then correct the charge. A void would erase the charge from the days the
    // write-off was in force, so once a write-off has covered a charge the charge is reversed, never voided.
    await reverseEntry(id, writeOffId, { reason: "It was collected after all" }, ADMIN);
    await expectApiError(voidEntry(id, chargeId, "Typo", ADMIN), 409, "write_off_history");
    await reverseEntry(id, chargeId, { reason: "Wrong customer" }, ADMIN);
    expect((await getDetail(id, TODAY)).customer).toMatchObject({ balanceCents: 0, writtenOffCents: 0 });
  });

  test("voiding the charge a write-off covered is refused even when a LATER charge has since brought the balance back up", async () => {
    const id = await approvedCustomer("Absorbed Charge Co");
    const { id: first } = await recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE);
    await recordEntry(id, writeOff(100_00), ADMIN);
    await recordEntry(id, entry("CHARGE", 100_00, { entryDate: addDays(TODAY, 1), dueDate: addDays(TODAY, 31) }), EMPLOYEE);

    // Today's balance is $100, so "balance minus $100 is not negative" looked fine, but the write-off would then be wiping out the new charge.
    await expectApiError(voidEntry(id, first, "Typo", ADMIN), 409, "write_off_covers");
  });

  test("an old write-off that is unrelated to a newer charge does not stop that charge being voided", async () => {
    const id = await approvedCustomer("Unrelated Write Off Co");
    await recordEntry(id, entry("CHARGE", 100_00, { entryDate: LAST_MONTH, dueDate: LAST_MONTH }), ADMIN);
    await recordEntry(id, writeOff(100_00, { entryDate: LAST_MONTH }), ADMIN);
    const { id: later } = await recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE);
    await recordEntry(id, entry("PAYMENT", 50_00), EMPLOYEE);
    // The write-off was dated before this charge, so it cannot have been covering it.
    await voidEntry(id, later, "Typo", ADMIN);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(-50_00);
  });

  test("a charge the write-off does NOT depend on can still be corrected", async () => {
    const id = await approvedCustomer("Independent Charge Co");
    await recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE);
    const { id: second } = await recordEntry(id, entry("CHARGE", 40_00), EMPLOYEE);
    await recordEntry(id, writeOff(60_00), ADMIN); // owed 140, wrote off 60: 80 remains, so removing the 40 still leaves 40 >= 0
    await voidEntry(id, second, "Typo", ADMIN);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(40_00);
  });
});

describe("who may post what, and when", () => {
  test("an employee cannot post into a closed month; an admin can; both can post into this month", async () => {
    const id = await approvedCustomer("Backdate Roles Co");
    await expectApiError(recordEntry(id, entry("CHARGE", 10_00, { entryDate: LAST_MONTH }), EMPLOYEE), 403, "closed_month_admin_only");
    await recordEntry(id, entry("CHARGE", 10_00, { entryDate: LAST_MONTH, dueDate: LAST_MONTH }), ADMIN);
    await recordEntry(id, entry("CHARGE", 10_00), EMPLOYEE);
    await recordEntry(id, entry("PAYMENT", 5_00, { entryDate: `${TODAY.slice(0, 8)}01` }), EMPLOYEE);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(15_00);
  });

  test("nobody can date an entry more than the limit ahead: the typo year that would hide it for decades", async () => {
    const id = await approvedCustomer("Far Ahead Co");
    await expectApiError(recordEntry(id, entry("CHARGE", 10_00, { entryDate: "2099-01-01" }), ADMIN), 422, "invalid_entry");
    await expectApiError(recordEntry(id, entry("CHARGE", 10_00, { entryDate: addDays(TODAY, MAX_POSTDATE_DAYS + 1) }), ADMIN), 422);
    const edge = await recordEntry(id, entry("CHARGE", 10_00, { entryDate: addDays(TODAY, MAX_POSTDATE_DAYS) }), EMPLOYEE);
    expect(edge.postDated).toBe(true);
  });

  test("an adjustment that raises what is owed needs an approved account; one that lowers it does not", async () => {
    const id = await approvedCustomer("Adjust Status Co");
    await recordEntry(id, entry("CHARGE", 100_00), EMPLOYEE);
    await decide(id, { action: "suspend", version: 2, reason: null }, ADMIN);

    await expectApiError(recordEntry(id, entry("ADJUSTMENT", 50_00), ADMIN), 409, "invalid_state");
    await recordEntry(id, entry("ADJUSTMENT", -30_00), ADMIN);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(70_00);
  });

  test("an approved account cannot be edited down to a $0 limit, which would silence every limit warning", async () => {
    const id = await approvedCustomer("Zero Limit Co");
    const detail = await getDetail(id, TODAY);
    const base = { ...profile("Zero Limit Co"), version: detail.customer.version };
    await expectApiError(updateCustomer(id, { ...base, creditLimitCents: 0 }, ADMIN), 422, "invalid_limit");
    await updateCustomer(id, { ...base, creditLimitCents: 5_000_00 }, ADMIN);
    expect((await getDetail(id, TODAY)).customer.creditLimitCents).toBe(5_000_00);
  });
});

describe("warnings are judged on today's books", () => {
  test("a charge dated ahead does not make today's charge look like it passed the limit", async () => {
    const id = await approvedCustomer("Warning Today Co", 1_000_00);
    await recordEntry(id, entry("CHARGE", 900_00, { entryDate: addDays(TODAY, 30) }), EMPLOYEE);
    const today = await recordEntry(id, entry("CHARGE", 200_00), EMPLOYEE);
    expect(today.warning).toBeNull(); // today's balance is $200 of a $1,000 limit
  });
});

describe("a request key means ONE submission", () => {
  test("the same key with the same details is a harmless retry, even after the account was suspended", async () => {
    const id = await approvedCustomer("Retry Suspended Co");
    const requestKey = randomUUID();
    const first = await recordEntry(id, entry("CHARGE", 25_00, { requestKey }), EMPLOYEE);
    await decide(id, { action: "suspend", version: 2, reason: null }, ADMIN);

    const retry = await recordEntry(id, entry("CHARGE", 25_00, { requestKey }), EMPLOYEE);
    expect(retry).toMatchObject({ id: first.id, duplicate: true });
  });

  test("creating a customer twice with one key returns the same customer, but an edited form with that key is refused", async () => {
    const key = randomUUID();
    const first = await createCustomer({ ...profile("Key Reuse Create Co"), requestKey: key }, EMPLOYEE);
    expect(await createCustomer({ ...profile("Key Reuse Create Co"), requestKey: key }, EMPLOYEE)).toBe(first);
    await expectApiError(createCustomer({ ...profile("Key Reuse Create Inc"), requestKey: key }, EMPLOYEE), 409, "request_key_reuse");
  });

  test("the same key with a DIFFERENT amount is refused: it is an edited form, not a retry, and 'recorded' would be a lie", async () => {
    const id = await approvedCustomer("Reused Key Co");
    await recordEntry(id, entry("CHARGE", 500_00), EMPLOYEE);
    const key = randomUUID();
    await recordEntry(id, entry("PAYMENT", 40_00, { requestKey: key }), EMPLOYEE);
    await expectApiError(recordEntry(id, entry("PAYMENT", 400_00, { requestKey: key }), EMPLOYEE), 409, "request_key_reuse");
    await expectApiError(recordEntry(id, entry("PAYMENT", 40_00, { requestKey: key, reference: "Now with a check number" }), EMPLOYEE), 409, "request_key_reuse");
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(460_00); // only the first submission was recorded
  });

  test("a reversal's key is tied to that entry and that reason", async () => {
    const id = await approvedCustomer("Reversal Key Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 20_00), EMPLOYEE);
    const { id: otherId } = await recordEntry(id, entry("CHARGE", 30_00), EMPLOYEE);
    const key = randomUUID();
    await reverseEntry(id, chargeId, { reason: "Entered twice", requestKey: key }, ADMIN);
    await expectApiError(reverseEntry(id, otherId, { reason: "Entered twice", requestKey: key }, ADMIN), 409, "request_key_reuse");
    await expectApiError(reverseEntry(id, chargeId, { reason: "A different reason", requestKey: key }, ADMIN), 409, "request_key_reuse");
  });
});

describe("the clock is injected, so month-end rules do not depend on when the test runs", () => {
  const clockOn = (today: string): Clock => ({ now: () => new Date(`${today}T12:00:00Z`), today: () => today });

  test("an entry from this month can be voided on its own day, and not once the month has turned", async () => {
    const id = await approvedCustomer("Month Turn Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 10_00), EMPLOYEE);
    const nextMonthFirst = addDays(`${TODAY.slice(0, 8)}28`, 5).slice(0, 8) + "01";

    const error = await voidEntry(id, chargeId, "Typo", ADMIN, clockOn(nextMonthFirst)).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ status: 409, code: "closed_month" });
    await voidEntry(id, chargeId, "Typo", ADMIN, clockOn(TODAY));
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(0);
  });

  test("a reversal is dated by the injected clock's today", async () => {
    const id = await approvedCustomer("Clock Reversal Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 10_00, { entryDate: LAST_MONTH, dueDate: LAST_MONTH }), ADMIN);
    const tomorrow = addDays(TODAY, 1);
    const { id: reversalId } = await reverseEntry(id, chargeId, { reason: "Wrong job" }, ADMIN, clockOn(tomorrow));
    expect((await getDetail(id, tomorrow)).ledger.find((e) => e.id === reversalId)?.entryDate).toBe(tomorrow);
  });
});

describe("the SQL balance and the TypeScript balance are the same rule", () => {
  test("for every kind of entry, voided entries and entries dated ahead included", async () => {
    const id = await approvedCustomer("Parity Co");
    const base = { customerId: id, createdBy: "raw", entryDate: new Date(`${TODAY}T00:00:00Z`) };
    const charge = await prisma.ledgerEntry.create({ data: { ...base, type: "CHARGE", amountCents: 100_00 } });
    await prisma.ledgerEntry.create({ data: { ...base, type: "CHARGE", amountCents: 80_00 } });
    await prisma.ledgerEntry.create({ data: { ...base, type: "PAYMENT", amountCents: 30_00 } });
    await prisma.ledgerEntry.create({ data: { ...base, type: "ADJUSTMENT", amountCents: 7_00 } });
    await prisma.ledgerEntry.create({ data: { ...base, type: "ADJUSTMENT", amountCents: -5_00 } });
    await prisma.ledgerEntry.create({ data: { ...base, type: "WRITE_OFF", amountCents: 10_00, note: "Uncollectible" } });
    await prisma.ledgerEntry.create({ data: { ...base, type: "REVERSAL", amountCents: -100_00, note: "Wrong job", reversesEntryId: charge.id } });
    await prisma.ledgerEntry.create({ data: { ...base, type: "CHARGE", amountCents: 999_00, entryDate: new Date(`${addDays(TODAY, 20)}T00:00:00Z`) } });
    await prisma.ledgerEntry.create({ data: { ...base, type: "CHARGE", amountCents: 777_00, voidedAt: new Date(), voidedBy: "x", voidReason: "typo" } });
    // Make sure this test really covers every type there is.
    expect(new Set(["CHARGE", "PAYMENT", "ADJUSTMENT", "WRITE_OFF", "REVERSAL"])).toEqual(new Set<LedgerType>(LEDGER_TYPES));

    const rows = await prisma.ledgerEntry.findMany({ where: { customerId: id } });
    const records: LedgerRecord[] = rows.map((row) => ({
      id: row.id, type: row.type as LedgerType, amountCents: row.amountCents, entryDate: row.entryDate.toISOString().slice(0, 10),
      dueDate: null, voided: row.voidedAt !== null,
    }));
    const expected = balanceCents(records.filter((record) => record.entryDate <= TODAY));
    const fromSql = await prisma.$transaction((tx) => balanceOf(tx, id, TODAY));
    expect(fromSql.balanceCents).toBe(expected);
    expect(expected).toBe(100_00 + 80_00 - 30_00 + 7_00 - 5_00 - 10_00 - 100_00);
  });
});

describe("the audit trail says who acted", () => {
  test("staff actions are marked staff", async () => {
    const id = await approvedCustomer("Actor Kind Co");
    await recordEntry(id, entry("CHARGE", 10_00), EMPLOYEE);
    const events = await prisma.auditEvent.findMany({ where: { customerId: id } });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.actorKind === "staff")).toBe(true);
  });

  test("an unknown kind of actor is refused by the database", async () => {
    const id = await approvedCustomer("Actor Check Co");
    await expect(prisma.auditEvent.create({ data: { customerId: id, action: "x", summary: "x", actor: "x", actorKind: "robot" } })).rejects.toThrow(/AuditEvent_actorKind_check/);
  });
});

describe("the CSV exports reconcile to the books", () => {
  test("the ledger export has a signed effect column, marks what counts today, and defuses formulas", async () => {
    const id = await approvedCustomer("Csv Co");
    const { id: chargeId } = await recordEntry(id, entry("CHARGE", 100_00, { reference: "INV-1" }), EMPLOYEE);
    await recordEntry(id, entry("PAYMENT", 40_00, { note: "=HYPERLINK(\"https://evil.example\")" }), EMPLOYEE);
    await recordEntry(id, entry("CHARGE", 25_00, { entryDate: addDays(TODAY, 10) }), EMPLOYEE);
    const { id: typoId } = await recordEntry(id, entry("CHARGE", 5_00), EMPLOYEE);
    await voidEntry(id, typoId, "Typo", ADMIN);
    await reverseEntry(id, chargeId, { reason: "Wrong job" }, ADMIN);

    const csv = await ledgerCsv(TODAY);
    const rows = csv.trim().split("\r\n");
    expect(rows[0]).toBe([...LEDGER_CSV_HEADER].join(","));
    expect(csv).toContain("'=HYPERLINK"); // defused
    const mine = rows.filter((row) => row.startsWith(`${id},`));
    const col = (row: string, name: (typeof LEDGER_CSV_HEADER)[number]) => row.split(",")[LEDGER_CSV_HEADER.indexOf(name)];
    // The rows that count today add up to the customer's balance, which is the point of the signed column.
    const counted = mine.filter((row) => col(row, "Counts today") === "yes").reduce((sum, row) => sum + Math.round(Number(col(row, "Effect on balance")) * 100), 0);
    expect(counted).toBe((await getDetail(id, TODAY)).customer.balanceCents);
    expect(mine.some((row) => col(row, "Counts today") === "no")).toBe(true); // the voided one and the one dated ahead
  });

  test("the customers export carries the customer id and the credit-on-account column", async () => {
    const id = await approvedCustomer("Csv Customers Co");
    const csv = await customersCsv(TODAY);
    const [header] = csv.split("\r\n");
    expect(header).toContain("Customer ID");
    expect(header).toContain("Credit on account");
    expect(csv).toContain(id);
  });
});
