"use client";

import { useState, type FormEvent } from "react";
import { ApiClientError } from "@/lib/client/api";
import { useVoidEntry } from "@/lib/client/queries";
import { formatDate } from "@/lib/domain/dates";
import { formatCents } from "@/lib/domain/money";
import { can } from "@/lib/domain/roles";
import type { LedgerEntryDto } from "@/lib/types";
import { useAutoFocus } from "../useAutoFocus";
import { useToast } from "../Toast";
import { useUi } from "../ui-context";

const LABEL = { CHARGE: "Charge", PAYMENT: "Payment", ADJUSTMENT: "Adjustment" } as const;

function VoidForm({ customerId, entry, onDone }: { customerId: string; entry: LedgerEntryDto; onDone: () => void }) {
  const notify = useToast();
  const voidEntry = useVoidEntry(customerId);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const formRef = useAutoFocus<HTMLFormElement>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (reason.trim().length < 3) return setError("Say why this entry is being voided.");
    try {
      await voidEntry.mutateAsync({ entryId: entry.id, reason: reason.trim() });
      notify("Entry voided.");
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "Could not void the entry.");
    }
  }

  return (
    <form ref={formRef} className="inline-form" style={{ gridColumn: "1 / -1", marginTop: 8 }} onSubmit={submit} noValidate aria-label="Void entry">
      {error ? <div className="form-error" role="alert" style={{ marginBottom: 0 }}>{error}</div> : null}
      <div className="col">
        <label htmlFor={`void-${entry.id}`}>Why is this being voided?</label>
        <input id={`void-${entry.id}`} type="text" value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
      </div>
      <div className="actions">
        <button type="button" className="btn btn-sm" onClick={onDone}>Keep entry</button>
        <button type="submit" className="btn btn-sm btn-danger" disabled={voidEntry.isPending}>Void entry</button>
      </div>
    </form>
  );
}

function amountText(entry: LedgerEntryDto): { text: string; paying: boolean } {
  const money = formatCents(Math.abs(entry.amountCents), { fixed: true });
  if (entry.type === "PAYMENT") return { text: `−${money}`, paying: true };
  return entry.amountCents < 0 ? { text: `−${money}`, paying: true } : { text: `+${money}`, paying: false };
}

export function LedgerList({ customerId, ledger }: { customerId: string; ledger: readonly LedgerEntryDto[] }) {
  const { user } = useUi();
  const [voiding, setVoiding] = useState<string | null>(null);
  const canVoid = can(user.role, "ledger.void");

  if (ledger.length === 0) return <div style={{ color: "var(--text-faint)", fontSize: "12.5px", padding: "10px 0" }}>No transactions yet.</div>;

  return (
    <div>
      {ledger.map((entry) => {
        const { text, paying } = amountText(entry);
        const details = [
          formatDate(entry.entryDate),
          entry.reference,
          entry.dueDate && entry.type !== "PAYMENT" ? `due ${formatDate(entry.dueDate)}` : null,
          entry.note,
          `by ${entry.createdBy}`,
        ].filter(Boolean);
        return (
          <div key={entry.id} className={`ledger-item${entry.voided ? " voided" : ""}`}>
            <div className="ledger-main">
              {LABEL[entry.type]}
              {entry.voided ? <span className="void-tag">Voided</span> : null}
            </div>
            <div className={`ledger-amount${paying ? " pay" : ""}`}>{text}</div>
            <div className="ledger-sub">
              {details.join(" · ")}
              {entry.voided ? <div>Voided by {entry.voidedBy}: {entry.voidReason}</div> : null}
            </div>
            {canVoid && !entry.voided ? (
              <div className="ledger-actions">
                <button type="button" className="link-danger" onClick={() => setVoiding(entry.id)} aria-label={`Void ${LABEL[entry.type].toLowerCase()} of ${text} dated ${formatDate(entry.entryDate)}`}>Void</button>
              </div>
            ) : null}
            {voiding === entry.id ? <VoidForm customerId={customerId} entry={entry} onDone={() => setVoiding(null)} /> : null}
          </div>
        );
      })}
    </div>
  );
}
