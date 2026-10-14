"use client";

import { useState, type FormEvent } from "react";
import { ApiClientError } from "@/lib/client/api";
import { useBusinessToday, useReverseEntry, useVoidEntry } from "@/lib/client/queries";
import { MIN_REASON_LENGTH } from "@/lib/domain/constants";
import { formatDate, isInClosedMonth } from "@/lib/domain/dates";
import { formatCents } from "@/lib/domain/money";
import { can } from "@/lib/domain/roles";
import type { LedgerEntryDto } from "@/lib/types";
import { useAutoFocus } from "../useAutoFocus";
import { useToast } from "../Toast";
import { useUi } from "../ui-context";

const LABEL = { CHARGE: "Charge", PAYMENT: "Payment", ADJUSTMENT: "Adjustment", WRITE_OFF: "Write-off", REVERSAL: "Reversal" } as const;

interface ReasonFormProps {
  entryId: string;
  formName: string;
  question: string;
  hint?: string;
  keepLabel: string;
  submitLabel: string;
  missingReason: string;
  success: string;
  failure: string;
  /** Sends the correction. The key is made once per form, so a retry after a lost reply cannot record it twice. */
  send: (reason: string, requestKey: string) => Promise<unknown>;
  onDone: () => void;
}

/** One reason, one button: the shared shape of "void this" and "reverse this". */
function ReasonForm(props: ReasonFormProps) {
  const notify = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [requestKey] = useState(() => crypto.randomUUID());
  const formRef = useAutoFocus<HTMLFormElement>();
  const inputId = `${props.formName.toLowerCase().replace(/\W+/g, "-")}-${props.entryId}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (reason.trim().length < MIN_REASON_LENGTH) return setError(props.missingReason);
    setPending(true);
    try {
      await props.send(reason.trim(), requestKey);
      notify(props.success);
      props.onDone();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : props.failure);
    } finally {
      setPending(false);
    }
  }

  return (
    <form ref={formRef} className="inline-form" style={{ gridColumn: "1 / -1", marginTop: 8 }} onSubmit={submit} noValidate aria-label={props.formName}>
      {error ? <div className="form-error" role="alert" style={{ marginBottom: 0 }}>{error}</div> : null}
      <div className="col">
        <label htmlFor={inputId}>{props.question}</label>
        <input id={inputId} type="text" value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus aria-describedby={props.hint ? `${inputId}-hint` : undefined} />
        {props.hint ? <span className="field-hint" id={`${inputId}-hint`}>{props.hint}</span> : null}
      </div>
      <div className="actions">
        <button type="button" className="btn btn-sm" onClick={props.onDone}>{props.keepLabel}</button>
        <button type="submit" className="btn btn-sm btn-danger" disabled={pending}>{props.submitLabel}</button>
      </div>
    </form>
  );
}

function VoidForm({ customerId, entry, onDone }: { customerId: string; entry: LedgerEntryDto; onDone: () => void }) {
  const voidEntry = useVoidEntry(customerId);
  return (
    <ReasonForm
      entryId={entry.id}
      formName="Void entry"
      question="Why is this being voided?"
      keepLabel="Keep entry"
      submitLabel="Void entry"
      missingReason="Say why this entry is being voided."
      success="Entry voided."
      failure="Could not void the entry."
      send={(reason) => voidEntry.mutateAsync({ entryId: entry.id, reason })}
      onDone={onDone}
    />
  );
}

function ReverseForm({ customerId, entry, onDone }: { customerId: string; entry: LedgerEntryDto; onDone: () => void }) {
  const reverseEntry = useReverseEntry(customerId);
  return (
    <ReasonForm
      entryId={entry.id}
      formName="Reverse entry"
      question="Why is this being reversed?"
      hint="Adds an opposite entry dated today. The original stays in the history, and past months do not change."
      keepLabel="Keep entry"
      submitLabel="Reverse entry"
      missingReason="Say why this entry is being reversed."
      success="Entry reversed."
      failure="Could not reverse the entry."
      send={(reason, requestKey) => reverseEntry.mutateAsync({ entryId: entry.id, reason, requestKey })}
      onDone={onDone}
    />
  );
}

/** Whether an entry reduces what the customer owes. */
function reduces(entry: LedgerEntryDto): boolean {
  if (entry.type === "PAYMENT" || entry.type === "WRITE_OFF") return true;
  return entry.type !== "CHARGE" && entry.amountCents < 0;
}

function amountText(entry: LedgerEntryDto): { text: string; paying: boolean } {
  const money = formatCents(Math.abs(entry.amountCents), { fixed: true });
  const paying = reduces(entry);
  return { text: `${paying ? "−" : "+"}${money}`, paying };
}

type Correction = "void" | "reverse";

export function LedgerList({ customerId, ledger }: { customerId: string; ledger: readonly LedgerEntryDto[] }) {
  const { user } = useUi();
  const today = useBusinessToday();
  const [correcting, setCorrecting] = useState<{ id: string; how: Correction } | null>(null);
  const canVoid = can(user.role, "ledger.void");
  const canReverse = can(user.role, "ledger.reverse");

  if (ledger.length === 0) return <div style={{ color: "var(--text-faint)", fontSize: "12.5px", padding: "10px 0" }}>No transactions yet.</div>;

  /** This month's entries can be voided (a typo); anything from a closed month is corrected with a reversal instead. */
  function correctionFor(entry: LedgerEntryDto): Correction | null {
    if (entry.voided || entry.reversed || entry.type === "REVERSAL") return null;
    if (isInClosedMonth(entry.entryDate, today)) return canReverse ? "reverse" : null;
    return canVoid ? "void" : null;
  }

  return (
    <div>
      {ledger.map((entry) => {
        const { text, paying } = amountText(entry);
        const how = correctionFor(entry);
        const details = [
          formatDate(entry.entryDate),
          entry.reference,
          entry.dueDate && (entry.type === "CHARGE" || entry.type === "ADJUSTMENT") ? `due ${formatDate(entry.dueDate)}` : null,
          entry.note,
          `by ${entry.createdBy}`,
        ].filter(Boolean);
        const verb = how === "reverse" ? "Reverse" : "Void";
        return (
          <div key={entry.id} className={`ledger-item${entry.voided ? " voided" : ""}${entry.reversed ? " reversed" : ""}`}>
            <div className="ledger-main">
              {LABEL[entry.type]}
              {entry.voided ? <span className="void-tag">Voided</span> : null}
              {entry.reversed ? <span className="void-tag">Reversed</span> : null}
            </div>
            <div className={`ledger-amount${paying ? " pay" : ""}`}>{text}</div>
            <div className="ledger-sub">
              {details.join(" · ")}
              {entry.voided ? <div>Voided by {entry.voidedBy}: {entry.voidReason}</div> : null}
            </div>
            {how ? (
              <div className="ledger-actions">
                <button
                  type="button"
                  className="link-danger"
                  onClick={() => setCorrecting({ id: entry.id, how })}
                  aria-label={`${verb} ${LABEL[entry.type].toLowerCase()} of ${text} dated ${formatDate(entry.entryDate)}`}
                >
                  {verb}
                </button>
              </div>
            ) : null}
            {correcting?.id === entry.id && correcting.how === "void" ? <VoidForm customerId={customerId} entry={entry} onDone={() => setCorrecting(null)} /> : null}
            {correcting?.id === entry.id && correcting.how === "reverse" ? <ReverseForm customerId={customerId} entry={entry} onDone={() => setCorrecting(null)} /> : null}
          </div>
        );
      })}
    </div>
  );
}
