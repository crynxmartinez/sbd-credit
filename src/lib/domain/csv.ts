/**
 * CSV for export. Cells that start with = + - @ or a tab/return would run as a formula when the file is opened in
 * Excel, so they are prefixed with an apostrophe. That is how a spreadsheet treats text that looks like a formula.
 * A plain number such as -30.00 is not a formula and is left alone, so negative balances stay numeric.
 */
const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

function cell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (typeof value === "string" && FORMULA_TRIGGERS.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return `${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}

/** Whole cents as a plain decimal for spreadsheets: 123456 -> "1234.56". */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
