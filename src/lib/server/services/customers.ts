import "server-only";
import { diffFields, summarizeChanges } from "@/lib/domain/diff";
import { can, type Action } from "@/lib/domain/roles";
import { computeAging } from "@/lib/domain/ledger";
import { toSummary } from "@/lib/domain/summary";
import { applyDecision } from "@/lib/domain/status";
import { formatCents } from "@/lib/domain/money";
import { dbDateToIso, isoToDbDate } from "@/lib/domain/dates";
import type { CustomerStatus } from "@/lib/domain/constants";
import type { CustomerDetail, CustomerSummary, SessionUser } from "@/lib/types";
import type { CustomerCreateInput, CustomerUpdateInput, DecisionInput } from "@/lib/validation";
import { prisma } from "../db";
import { BUSINESS_TIME_ZONE, businessToday } from "../as-of";
import { transaction } from "../tx";
import { ApiError } from "../http";
import { toAuditDto, toCustomerBase, toLedgerDto, toLedgerRecord } from "../serialize";
import { writeAudit } from "./audit";

const TRACKED_FIELDS = {
  businessName: "Business name",
  contactName: "Contact name",
  phone: "Phone",
  email: "Email",
  billingAddress: "Billing address",
  dateApplied: "Date applied",
  requestedLimitCents: "Requested limit",
  accountingAppName: "Accounting app",
  accountingProjectUrl: "Accounting link",
  notes: "Notes",
  creditLimitCents: "Credit limit",
  paymentTerms: "Payment terms",
  creditStartDate: "Credit start date",
} as const;

const AUDIT_HISTORY_LIMIT = 200;
const notFound = () => new ApiError(404, "not_found", "That customer no longer exists.");
const stale = () =>
  new ApiError(409, "stale", "Someone else changed this customer. Reload to see the latest, then try again.");

export async function listSummaries(asOf: string): Promise<CustomerSummary[]> {
  const [customers, entries] = await Promise.all([
    prisma.customer.findMany({ orderBy: { businessName: "asc" } }),
    // Voided entries never affect a balance or an aging bucket, so there is no reason to read them here.
    prisma.ledgerEntry.findMany({
      where: { voidedAt: null },
      select: { id: true, customerId: true, type: true, amountCents: true, entryDate: true, dueDate: true, voidedAt: true, reversesEntryId: true },
    }),
  ]);

  const byCustomer = new Map<string, ReturnType<typeof toLedgerRecord>[]>();
  for (const entry of entries) {
    const list = byCustomer.get(entry.customerId);
    if (list) list.push(toLedgerRecord(entry));
    else byCustomer.set(entry.customerId, [toLedgerRecord(entry)]);
  }
  return customers.map((row) => toSummary(toCustomerBase(row), byCustomer.get(row.id) ?? [], asOf));
}

export async function getDetail(id: string, asOf: string): Promise<CustomerDetail> {
  const row = await prisma.customer.findUnique({
    where: { id },
    include: {
      ledger: { include: { reversedBy: { select: { id: true } } }, orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }, { id: "desc" }] },
      // The id breaks ties between events written in the same millisecond, so history never reshuffles between loads.
      audit: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: AUDIT_HISTORY_LIMIT },
    },
  });
  if (!row) throw notFound();

  const records = row.ledger.map(toLedgerRecord);
  return {
    customer: toSummary(toCustomerBase(row), records, asOf),
    aging: computeAging(records, asOf),
    ledger: row.ledger.map(toLedgerDto),
    audit: row.audit.map(toAuditDto),
  };
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

/** Creates an application. The same form submission, retried, returns the customer it already created. */
export async function createCustomer(input: CustomerCreateInput, actor: SessionUser): Promise<string> {
  const earlierFor = async (key: string | undefined) =>
    key ? (await prisma.customer.findUnique({ where: { requestKey: key }, select: { id: true } }))?.id : undefined;

  const earlier = await earlierFor(input.requestKey);
  if (earlier) return earlier;

  try {
    return await insertCustomer(input, actor);
  } catch (error) {
    // Two identical submissions racing: the unique key let one in; the other returns that one.
    const raced = isUniqueViolation(error) ? await earlierFor(input.requestKey) : undefined;
    if (raced) return raced;
    throw error;
  }
}

async function insertCustomer(input: CustomerCreateInput, actor: SessionUser): Promise<string> {
  return transaction(async (tx) => {
    const created = await tx.customer.create({
      data: {
        ...input,
        dateApplied: isoToDbDate(input.dateApplied),
        statusChangedOn: isoToDbDate(input.dateApplied),
        status: "submitted",
      },
    });
    await writeAudit(tx, {
      customerId: created.id,
      action: "customer.created",
      summary: "Application created",
      actor: actor.name,
      actorId: actor.id,
    });
    return created.id;
  });
}

function creditTermsChanged(
  current: { creditLimitCents: number; paymentTerms: string; creditStartDate: Date | null },
  input: CustomerUpdateInput,
): boolean {
  const startIso = dbDateToIso(current.creditStartDate);
  return (
    (input.creditLimitCents !== undefined && input.creditLimitCents !== current.creditLimitCents) ||
    (input.paymentTerms !== undefined && input.paymentTerms !== current.paymentTerms) ||
    (input.creditStartDate !== undefined && (input.creditStartDate ?? null) !== startIso)
  );
}

export async function updateCustomer(id: string, input: CustomerUpdateInput, actor: SessionUser): Promise<void> {
  const { version: expectedVersion, ...profile } = input;
  const current = await prisma.customer.findUnique({ where: { id } });
  if (!current) throw notFound();
  if (current.version !== expectedVersion) throw stale();

  if (creditTermsChanged(current, input)) {
    if (!can(actor.role, "customer.change_credit")) {
      throw new ApiError(403, "forbidden", "Only an admin can change credit terms.");
    }
    if (current.status !== "approved" && current.status !== "suspended") {
      throw new ApiError(400, "invalid_state", "Credit terms are set when the application is approved.");
    }
  }

  const next = {
    ...profile,
    creditLimitCents: input.creditLimitCents ?? current.creditLimitCents,
    paymentTerms: input.paymentTerms ?? current.paymentTerms,
    creditStartDate: input.creditStartDate === undefined ? current.creditStartDate : input.creditStartDate ? isoToDbDate(input.creditStartDate) : null,
  };
  const comparable = (record: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, value instanceof Date ? dbDateToIso(value) : value]),
    ) as Record<string, string | number | null>;
  const changes = diffFields(comparable(current), comparable({ ...next, dateApplied: profile.dateApplied }), TRACKED_FIELDS);

  await transaction(async (tx) => {
    const result = await tx.customer.updateMany({
      where: { id, version: expectedVersion },
      data: { ...next, dateApplied: isoToDbDate(profile.dateApplied), version: { increment: 1 } },
    });
    if (result.count === 0) throw stale();
    await writeAudit(tx, {
      customerId: id,
      action: "customer.updated",
      summary: summarizeChanges(changes),
      actor: actor.name,
      actorId: actor.id,
      changes,
    });
  });
}

function describeDecision(input: DecisionInput): string {
  switch (input.action) {
    case "start_review":
      return "Moved to under review";
    case "approve":
      return `Approved — ${formatCents(input.creditLimitCents)} at ${input.paymentTerms}`;
    case "deny":
      return input.reason ? `Denied — ${input.reason}` : "Denied";
    case "suspend":
      return input.reason ? `Credit suspended — ${input.reason}` : "Credit suspended";
    case "reopen":
      return "Reopened for review";
  }
}

export async function decide(id: string, input: DecisionInput, actor: SessionUser): Promise<void> {
  if (!can(actor.role, `decision.${input.action}` as Action)) {
    throw new ApiError(403, "forbidden", "Only an admin can make that decision.");
  }
  const current = await prisma.customer.findUnique({ where: { id }, select: { status: true, version: true } });
  if (!current) throw notFound();
  if (current.version !== input.version) throw stale();

  const outcome = applyDecision(current.status as CustomerStatus, input.action);
  if (!outcome.ok) throw new ApiError(409, "invalid_transition", outcome.reason);

  const approval =
    input.action === "approve"
      ? {
          creditLimitCents: input.creditLimitCents,
          paymentTerms: input.paymentTerms,
          creditStartDate: isoToDbDate(input.creditStartDate),
        }
      : {};

  await transaction(async (tx) => {
    const result = await tx.customer.updateMany({
      where: { id, version: input.version },
      data: {
        status: outcome.to,
        statusChangedOn: isoToDbDate(businessToday(new Date(), BUSINESS_TIME_ZONE)),
        ...approval,
        version: { increment: 1 },
      },
    });
    if (result.count === 0) throw stale();
    await writeAudit(tx, {
      customerId: id,
      action: `decision.${input.action}`,
      summary: describeDecision(input),
      actor: actor.name,
      actorId: actor.id,
    });
  });
}
