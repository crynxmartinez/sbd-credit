import { MAX_AMOUNT_CENTS } from "./constants";

/** Money is integer cents everywhere. These are the only places dollars and cents are converted. */

interface ParseOptions {
  /** Adjustments may be negative; everything else may not. */
  allowNegative?: boolean;
}

const DECIMAL_PATTERN = /^-?(\d+(\.\d{0,2})?|\.\d{1,2})$/;
/** Commas are accepted only as thousands separators: "1,234" yes, "1,23,4" and "12,34" no. */
const GROUPED_PATTERN = /^-?(\d{1,3}(,\d{3})+|\d*)(\.\d*)?$/;

/**
 * Turns user input ("1,234.56", "$12", 12.5) into integer cents, or null when it is not a clean amount.
 * Strings are parsed digit by digit so no floating-point error can creep in.
 */
export function parseMoneyToCents(input: string | number, options: ParseOptions = {}): number | null {
  const cents = typeof input === "number" ? numberToCents(input) : stringToCents(input);
  if (cents === null) return null;
  if (cents < 0 && !options.allowNegative) return null;
  if (Math.abs(cents) > MAX_AMOUNT_CENTS) return null;
  return cents;
}

function numberToCents(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const scaled = value * 100;
  const rounded = Math.round(scaled);
  // Allow float noise (0.1 + 0.2), refuse a genuine third decimal place (1.234).
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : null;
}

function stringToCents(raw: string): number | null {
  if (typeof raw !== "string") return null;
  const unprefixed = raw.trim().replace(/^\$/, "");
  if (!GROUPED_PATTERN.test(unprefixed)) return null;
  const cleaned = unprefixed.replace(/,/g, "");
  if (!DECIMAL_PATTERN.test(cleaned)) return null;

  const negative = cleaned.startsWith("-");
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const cents = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
}

interface FormatOptions {
  /** Always show two decimals (ledger columns). Default drops ".00" on whole dollars. */
  fixed?: boolean;
}

// One formatter for every call: building a new one each time was measurable on a page of thousands of rows.
const WHOLE_DOLLARS = new Intl.NumberFormat("en-US");

export function formatCents(cents: number, options: FormatOptions = {}): string {
  // A missing or broken amount shows as a dash. Showing "$0" would pass a data fault off as a real zero balance.
  if (!Number.isFinite(cents)) return "—";
  const safe = Math.trunc(cents);
  const sign = safe < 0 ? "-" : "";
  const abs = Math.abs(safe);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  const wholePart = WHOLE_DOLLARS.format(dollars);

  if (remainder === 0 && !options.fixed) return `${sign}$${wholePart}`;
  return `${sign}$${wholePart}.${String(remainder).padStart(2, "0")}`;
}

export function sumCents(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
