/**
 * Calendar dates are plain "YYYY-MM-DD" strings. They are never run through toISOString().slice(0, 10) for "today",
 * because that is the UTC day and flips to tomorrow in the US evening.
 */

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;
const FALLBACK_TERM_DAYS = 30;
/** Dates outside this range are typos, and a year like 9999 overflows once terms are added. */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function utcMs(iso: string): number {
  const match = ISO_DATE_PATTERN.exec(iso);
  if (!match) throw new Error(`Invalid ISO date: ${iso}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Today's date on the viewer's calendar. `now` is injectable so tests never depend on the clock. */
export function todayISO(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// One formatter per time zone: building an Intl.DateTimeFormat is slow, and this runs for every row of a long history.
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar day (YYYY-MM-DD) that a moment falls on in a given time zone. */
export function dateInZone(moment: Date, timeZone: string): string {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    // The en-CA locale prints dates as YYYY-MM-DD.
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter.format(moment);
}

/**
 * Plain character order. ISO dates and our ids are plain ASCII, where this is the same order as localeCompare, without building
 * locale machinery on every comparison of a sort over thousands of rows.
 */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isValidISODate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * True when `entryDate` falls in a calendar month before the one `today` is in. Past months are closed: whatever was
 * reported for them stays as it was, so a correction is made as a new entry dated today instead of by erasing one.
 */
export function isInClosedMonth(entryDate: string, today: string): boolean {
  return entryDate.slice(0, 7) < today.slice(0, 7);
}

export function addDays(iso: string, days: number): string {
  return fromUtcMs(utcMs(iso) + days * MS_PER_DAY);
}

/** Whole days from `fromIso` to `toIso`. Positive when `toIso` is later. */
export function diffDays(fromIso: string, toIso: string): number {
  return Math.round((utcMs(toIso) - utcMs(fromIso)) / MS_PER_DAY);
}

export function termDays(terms: string): number {
  if (terms === "Due on receipt" || terms === "COD") return 0;
  const match = /^Net (\d+)$/.exec(terms);
  return match ? Number(match[1]) : FALLBACK_TERM_DAYS;
}

export function dueDateFor(entryDate: string, terms: string): string {
  return addDays(entryDate, termDays(terms));
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso || !isValidISODate(iso)) return "—";
  const [year, month, day] = iso.split("-");
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}

/** Postgres DATE columns come back as a Date at UTC midnight; these two convert at the database boundary. */
export function isoToDbDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function dbDateToIso(date: Date | null | undefined): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}
