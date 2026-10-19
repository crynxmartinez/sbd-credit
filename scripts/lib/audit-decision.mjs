/**
 * Decides what `npm audit --omit=dev --json` means for the build. Pure, so it can be tested.
 *
 * It must FAIL CLOSED: if the audit itself did not run (registry down, an error report instead of a vulnerability list), the
 * answer is "not ok", never "nothing found".
 */
export const PRISMA_TOOL_CHAIN = new Set(["prisma", "@prisma/config", "deepmerge-ts", "mysql2"]);

export function decideAudit(report) {
  if (report === null || typeof report !== "object") return { ok: false, reason: "the audit report is not readable", blocking: [], tolerated: [] };
  if (report.error) {
    const detail = typeof report.error === "object" ? (report.error.summary ?? report.error.code ?? "an error") : String(report.error);
    return { ok: false, reason: `npm audit itself failed: ${detail}`, blocking: [], tolerated: [] };
  }
  if (report.vulnerabilities === undefined || report.vulnerabilities === null || typeof report.vulnerabilities !== "object") {
    return { ok: false, reason: "the audit report has no vulnerability list, so it did not really run", blocking: [], tolerated: [] };
  }
  const entries = Object.entries(report.vulnerabilities);
  // Critical anywhere blocks. High blocks unless it is only the Prisma command-line tool chain (see docs/PRODUCTION.md).
  const blocking = entries
    .filter(([name, entry]) => ["high", "critical"].includes(entry.severity) && (entry.severity === "critical" || !PRISMA_TOOL_CHAIN.has(name)))
    .map(([name, entry]) => ({ name, severity: entry.severity, range: entry.range ?? "?" }));
  const tolerated = entries.filter(([name]) => PRISMA_TOOL_CHAIN.has(name)).map(([name]) => name);
  return { ok: blocking.length === 0, reason: blocking.length ? "high or critical problems in runtime dependencies" : "", blocking, tolerated };
}
