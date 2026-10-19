"use client";

import { newRequestKey } from "@/lib/client/request-key";
import { useState, type FormEvent } from "react";
import { ApiClientError } from "@/lib/client/api";
import { useBusinessToday, useReverseEntry, useVoidEntry } from "@/lib/client/queries";
import { MIN_REASON_LENGTH } from "@/lib/domain/constants";
import { correctionFor, type Correction } from "@/lib/domain/corrections";
import { formatDate } from "@/lib/domain/dates";
import { chargeLabel } from "@/lib/client/ledger-records";
import { effectOnBalance } from "@/lib/domain/ledger";
import { formatCents } from "@/lib/domain/money";
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
  const [requestKey] = useState(() => newRequestKey());
  const formRef = useAutoFocus<HTMLFormElement>();
  const inputId = `${props.formName.toLowerCase().replace(/\W+/g, "-")}-${props.entryId}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
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

/** Direction comes from the same rule the server and the CSV use, so a type added later cannot be drawn the wrong way. */
function amountText(entry: LedgerEntryDto): { text: string; paying: boolean } {
  const effect = effectOnBalance(entry.type, entry.amountCents);
  const money = formatCents(Math.abs(effect), { fixed: true });
  return { text: `${effect < 0 ? "−" : "+"}${money}`, paying: effect < 0 };
}

export function LedgerList({ customerId, ledger }: { customerId: string; ledger: readonly LedgerEntryDto[] }) {
  const { user } = useUi();
  const today = useBusinessToday();
  const [correcting, setCorrecting] = useState<{ id: string; how: Correction } | null>(null);
  const byId = new Map(ledger.map((entry) => [entry.id, entry]));

  if (ledger.length === 0) return <div style={{ color: "var(--text-faint)", fontSize: "12.5px", padding: "10px 0" }}>No transactions yet.</div>;

  return (
    <ul className="ledger-list">
      {ledger.map((entry) => {
        const { text, paying } = amountText(entry);
        // This month's entries can be voided (a typo); anything from a closed month is reversed instead. One rule, shared with the server.
        const how = correctionFor(entry, today, user.role);
        const details = [
          formatDate(entry.entryDate),
          entry.reference,
          entry.dueDate && (entry.type === "CHARGE" || entry.type === "ADJUSTMENT") ? `due ${formatDate(entry.dueDate)}` : null,
          entry.note,
          // A write-off says which charges it covers.
          entry.type === "WRITE_OFF" && entry.covers.length > 0
            ? `covers ${entry.covers.map((cover) => `${chargeLabel(byId.get(cover.chargeId))} (${formatCents(cover.amountCents, { fixed: true })})`).join(", ")}`
            : null,
          `by ${entry.createdBy}`,
        ].filter(Boolean);
        const verb = how === "reverse" ? "Reverse" : "Void";
        return (
          <li key={entry.id} className={`ledger-item${entry.voided ? " voided" : ""}${entry.reversed ? " reversed" : ""}`}>
            <div className="ledger-main">
              <span className="ledger-label">{LABEL[entry.type]}</span>
              {entry.voided ? <span className="void-tag">Voided</span> : null}
              {entry.reversed ? <span className="void-tag">Reversed</span> : null}
              {entry.writtenOffCents > 0 ? <span className="void-tag">Written off {formatCents(entry.writtenOffCents, { fixed: true })}</span> : null}
            </div>
            <div className={`ledger-amount${paying ? " pay" : ""}`}>{text}</div>
            <div className="ledger-sub">
              {details.join(" · ")}
              {entry.voided ? <div>Voided by {entry.voidedBy}: {entry.voidReason}</div> : null}
              {entry.writtenOffCents > 0 && !entry.voided && !entry.reversed ? <div>A write-off covers this charge. Reverse that write-off first to correct it.</div> : null}
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
          </li>
        );
      })}
    </ul>
  );
}
