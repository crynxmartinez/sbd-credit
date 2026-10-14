"use client";

import { useBusinessTimeZone } from "@/lib/client/queries";
import { dateInZone, formatDate } from "@/lib/domain/dates";
import type { FieldChange } from "@/lib/domain/diff";
import { formatCents } from "@/lib/domain/money";
import type { AuditEventDto } from "@/lib/types";

/** The server sends the most recent events up to this many. If exactly this many arrive, older ones exist that are not shown. */
export const AUDIT_HISTORY_LIMIT = 200;

function show(change: FieldChange, value: string | number | null): string {
  if (value === null || value === "") return "none";
  if (change.field.endsWith("Cents") && typeof value === "number") return formatCents(value);
  return String(value);
}

export function HistoryList({ audit }: { audit: readonly AuditEventDto[] }) {
  // Shown on the day the books say it happened, the same day an entry dated that day carries, not the viewer's own date.
  const timeZone = useBusinessTimeZone();
  if (audit.length === 0) return <div style={{ color: "var(--text-faint)", fontSize: "12.5px", padding: "10px 0" }}>No history yet.</div>;
  return (
    <>
      <ul className="history-list">
        {audit.map((event) => (
          <li key={event.id} className="history-item">
            <div className="history-date">{formatDate(dateInZone(new Date(event.createdAt), timeZone))}</div>
            <div className="history-text">
              {event.summary} <span className="history-by">— {event.actor}</span>
              {event.changes?.map((change) => (
                <div key={change.field} className="history-by" style={{ fontSize: 12 }}>
                  {change.label}: {show(change, change.from)} → {show(change, change.to)}
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {audit.length >= AUDIT_HISTORY_LIMIT ? <p className="ledger-sub">Showing the most recent {AUDIT_HISTORY_LIMIT} events. Older history is kept but not shown here.</p> : null}
    </>
  );
}
