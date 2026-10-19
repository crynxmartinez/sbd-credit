import { compareText } from "./dates";
import type { CustomerSummary } from "../types";
import type { CustomerStatus } from "./constants";

export type SortKey = "name" | "status" | "limit" | "balance" | "utilization" | "nextDue";
export type SortDirection = "asc" | "desc";
export type StatusFilter = CustomerStatus | "all";

export const SORT_KEYS: readonly SortKey[] = ["name", "status", "limit", "balance", "utilization", "nextDue"];

/** Built once. localeCompare builds its own locale machinery on every call, which adds up when sorting thousands of rows. */
const COLLATOR = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const byName = (a: CustomerSummary, b: CustomerSummary): number => COLLATOR.compare(a.businessName, b.businessName);

const STATUS_RANK: Readonly<Record<CustomerStatus, number>> = {
  submitted: 0,
  under_review: 1,
  approved: 2,
  suspended: 3,
  denied: 4,
};

export function isSortKey(value: string | null): value is SortKey {
  return value !== null && (SORT_KEYS as readonly string[]).includes(value);
}

function compareBy(key: SortKey, a: CustomerSummary, b: CustomerSummary): number {
  switch (key) {
    case "name":
      return byName(a, b);
    case "status":
      return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    case "limit":
      return a.creditLimitCents - b.creditLimitCents;
    case "balance":
      return a.balanceCents - b.balanceCents;
    case "utilization":
      return a.utilizationPct - b.utilizationPct;
    case "nextDue":
      return compareText(a.nextDueDate ?? "", b.nextDueDate ?? "");
  }
}

/** Sorted copy. Customers with no next due date always sort last, whichever way the column runs. */
export function sortCustomers(
  customers: readonly CustomerSummary[],
  key: SortKey,
  direction: SortDirection,
): CustomerSummary[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...customers].sort((a, b) => {
    if (key === "nextDue" && (!a.nextDueDate || !b.nextDueDate)) {
      if (!a.nextDueDate && !b.nextDueDate) return byName(a, b);
      return a.nextDueDate ? -1 : 1;
    }
    return sign * compareBy(key, a, b) || byName(a, b);
  });
}

export function filterCustomers(
  customers: readonly CustomerSummary[],
  status: StatusFilter,
  query: string,
): CustomerSummary[] {
  const needle = query.trim().toLowerCase();
  return customers.filter((customer) => {
    if (status !== "all" && customer.status !== status) return false;
    if (!needle) return true;
    return [customer.businessName, customer.contactName, customer.email, customer.phone, customer.notes].some((field) =>
      field?.toLowerCase().includes(needle),
    );
  });
}
