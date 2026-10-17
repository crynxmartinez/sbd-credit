import type { Alert, UtilizationLevel } from "./domain/alerts";
import type { AgingBucket, CustomerStatus, LedgerType } from "./domain/constants";
import type { FieldChange } from "./domain/diff";
import type { Aging } from "./domain/ledger";
import type { ContactStatus } from "./domain/portal-users";
import type { Role } from "./domain/roles";

/** What the API sends to the browser. Dates are "YYYY-MM-DD" or ISO timestamps, money is integer cents. */

export interface CustomerBase {
  id: string;
  businessName: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  billingAddress: string | null;
  status: CustomerStatus;
  dateApplied: string;
  /** The day the customer entered their current status. */
  statusChangedDate: string;
  requestedLimitCents: number | null;
  creditLimitCents: number;
  paymentTerms: string;
  creditStartDate: string | null;
  accountingAppName: string | null;
  accountingProjectUrl: string | null;
  notes: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerMetrics {
  balanceCents: number;
  creditCents: number;
  availableCents: number;
  utilizationPct: number;
  utilizationLevel: UtilizationLevel;
  overdueCents: number;
  oldestOverdueDays: number;
  nextDueDate: string | null;
  nextDueCents: number;
  buckets: Record<AgingBucket, number>;
  /** Debt given up on, as of the business day. Already out of the balance; shown so it is not forgotten. */
  writtenOffCents: number;
}

export type CustomerSummary = CustomerBase & CustomerMetrics;

export interface LedgerEntryDto {
  id: string;
  type: LedgerType;
  amountCents: number;
  entryDate: string;
  dueDate: string | null;
  reference: string | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  voided: boolean;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  /** For a reversal, the entry it offsets. */
  reversesId: string | null;
  /** True once a reversal has been recorded against this entry. */
  reversed: boolean;
  /** For a write-off: the charges it gives up on and how much of each. Empty for anything else, and for older write-offs. */
  covers: Array<{ chargeId: string; amountCents: number }>;
  /** For a charge: how much of it is written off right now. */
  writtenOffCents: number;
  /** For a charge: whether a write-off that is still on the books (live, or reversed since) ever covered it. */
  everWrittenOff: boolean;
}

export interface AuditEventDto {
  id: string;
  action: string;
  summary: string;
  actor: string;
  createdAt: string;
  changes: FieldChange[] | null;
}

/** The customer list plus the business day every figure in it was computed for. */
export interface CustomerListDto {
  asOf: string;
  /** The time zone the books are kept in, so a timestamp can be shown on the day the books say it happened. */
  timeZone: string;
  customers: CustomerSummary[];
}

export interface CustomerDetail {
  customer: CustomerSummary;
  aging: Aging;
  ledger: LedgerEntryDto[];
  audit: AuditEventDto[];
}

export interface DashboardStats {
  totalCustomers: number;
  pendingApplications: number;
  activeAccounts: number;
  totalExtendedCents: number;
  totalOutstandingCents: number;
  totalOverdueCents: number;
  totalWrittenOffCents: number;
  needsAttention: number;
}

export interface DashboardDto {
  stats: DashboardStats;
  alerts: Alert[];
  aging: Record<AgingBucket, number>;
  recent: CustomerSummary[];
}

export interface SessionUser {
  id: string;
  username: string;
  name: string;
  role: Role;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  error: { code: string; message: string; fields?: Record<string, string> };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** One person at a customer who may sign in to the customer portal. Never carries a password hash or a link token. */
export interface PortalContactDto {
  id: string;
  name: string;
  email: string;
  status: ContactStatus;
  lastLoginAt: string | null;
  /** When the live invitation runs out, if there is one. */
  inviteExpiresAt: string | null;
}

/** What creating or re-sending an invitation returns. The link is shown once and is never available again. */
export interface PortalInviteResult {
  contact: PortalContactDto;
  link: string;
  expiresAt: string;
}
