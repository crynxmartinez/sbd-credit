/**
 * The time zone the business keeps its books in. "Today" for overdue and aging is the calendar day here, never the
 * server's UTC day (which turns over mid-evening in the US) and never whatever a viewer's clock says, so everyone looking
 * at the same ledger sees the same figures. Override with BUSINESS_TIME_ZONE.
 */
export const BUSINESS_TIME_ZONE = process.env.BUSINESS_TIME_ZONE ?? "America/Chicago";

export function businessToday(now: Date = new Date(), timeZone: string = BUSINESS_TIME_ZONE): string {
  // The en-CA locale prints dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
