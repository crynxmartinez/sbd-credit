import { formatDate, todayISO } from "@/lib/domain/dates";
import type { FieldChange } from "@/lib/domain/diff";
import { formatCents } from "@/lib/domain/money";
import type { AuditEventDto } from "@/lib/types";

function show(change: FieldChange, value: string | number | null): string {
  if (value === null || value === "") return "none";
  if (change.field.endsWith("Cents") && typeof value === "number") return formatCents(value);
  return String(value);
}

export function HistoryList({ audit }: { audit: readonly AuditEventDto[] }) {
  if (audit.length === 0) return <div style={{ color: "var(--text-faint)", fontSize: "12.5px", padding: "10px 0" }}>No history yet.</div>;
  return (
    <div>
      {audit.map((event) => (
        <div key={event.id} className="history-item">
          <div className="history-date">{formatDate(todayISO(new Date(event.createdAt)))}</div>
          <div className="history-text">
            {event.summary} <span className="history-by">— {event.actor}</span>
            {event.changes?.map((change) => (
              <div key={change.field} className="history-by" style={{ fontSize: 12 }}>
                {change.label}: {show(change, change.from)} → {show(change, change.to)}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
