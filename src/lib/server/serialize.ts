import type { AuditEvent, Customer, LedgerEntry } from "@/generated/prisma/client";
import type { CustomerStatus, LedgerType } from "@/lib/domain/constants";
import { dbDateToIso } from "@/lib/domain/dates";
import type { FieldChange } from "@/lib/domain/diff";
import type { LedgerRecord } from "@/lib/domain/ledger";
import type { AuditEventDto, CustomerBase, LedgerEntryDto } from "@/lib/types";

/** Database rows to plain API shapes. The only place Date objects become strings. */

/** A non-null date column that comes back empty means a damaged row. Say so loudly rather than invent an empty date. */
function requiredDate(date: Date | null, field: string, rowId: string): string {
  const iso = dbDateToIso(date);
  if (!iso) throw new Error(`Corrupt row ${rowId}: ${field} is missing`);
  return iso;
}

export function toCustomerBase(row: Customer): CustomerBase {
  return {
    id: row.id,
    businessName: row.businessName,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    billingAddress: row.billingAddress,
    status: row.status as CustomerStatus,
    dateApplied: requiredDate(row.dateApplied, "dateApplied", row.id),
    statusChangedDate: requiredDate(row.statusChangedOn, "statusChangedOn", row.id),
    requestedLimitCents: row.requestedLimitCents,
    creditLimitCents: row.creditLimitCents,
    paymentTerms: row.paymentTerms,
    creditStartDate: dbDateToIso(row.creditStartDate),
    accountingAppName: row.accountingAppName,
    accountingProjectUrl: row.accountingProjectUrl,
    notes: row.notes,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toLedgerRecord(
  row: Pick<LedgerEntry, "id" | "type" | "amountCents" | "entryDate" | "dueDate" | "voidedAt" | "reversesEntryId">,
): LedgerRecord {
  return {
    id: row.id,
    type: row.type as LedgerType,
    amountCents: row.amountCents,
    entryDate: requiredDate(row.entryDate, "entryDate", row.id),
    dueDate: dbDateToIso(row.dueDate),
    voided: row.voidedAt !== null,
    reverses: row.reversesEntryId,
  };
}

/** A ledger row, plus whether a reversal has been recorded against it. */
export type LedgerRow = LedgerEntry & { reversedBy: { id: string } | null };

export function toLedgerDto(row: LedgerRow): LedgerEntryDto {
  return {
    id: row.id,
    type: row.type as LedgerType,
    amountCents: row.amountCents,
    entryDate: requiredDate(row.entryDate, "entryDate", row.id),
    dueDate: dbDateToIso(row.dueDate),
    reference: row.reference,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    voided: row.voidedAt !== null,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    voidedBy: row.voidedBy,
    voidReason: row.voidReason,
    reversesId: row.reversesEntryId,
    reversed: row.reversedBy !== null,
  };
}

export function toAuditDto(row: AuditEvent): AuditEventDto {
  return {
    id: row.id,
    action: row.action,
    summary: row.summary,
    actor: row.actor,
    createdAt: row.createdAt.toISOString(),
    changes: Array.isArray(row.changes) ? (row.changes as unknown as FieldChange[]) : null,
  };
}
