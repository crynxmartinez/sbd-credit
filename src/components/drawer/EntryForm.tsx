"use client";

import { useState, type FormEvent } from "react";
import { ApiClientError } from "@/lib/client/api";
import { useBusinessToday, useRecordEntry } from "@/lib/client/queries";
import { formatCents, parseMoneyToCents } from "@/lib/domain/money";
import { ledgerEntrySchema } from "@/lib/validation";
import { useAutoFocus } from "../useAutoFocus";
import { useToast } from "../Toast";

export type EntryKind = "payment" | "charge" | "adjustment" | "writeoff";

const TYPE_OF = { payment: "PAYMENT", charge: "CHARGE", adjustment: "ADJUSTMENT", writeoff: "WRITE_OFF" } as const;
const TITLE = { payment: "Record payment", charge: "Add charge", adjustment: "Post adjustment", writeoff: "Write off" } as const;
const DONE = { payment: "Payment recorded.", charge: "Charge added.", adjustment: "Adjustment posted.", writeoff: "Written off." } as const;

interface Props {
  customerId: string;
  kind: EntryKind;
  paymentTerms: string;
  /** What the customer owes now. A write-off cannot exceed it. */
  owedCents: number;
  onDone: () => void;
}

export function EntryForm({ customerId, kind, paymentTerms, owedCents, onDone }: Props) {
  const notify = useToast();
  const record = useRecordEntry(customerId);
  const [amount, setAmount] = useState("");
  const today = useBusinessToday();
  const [entryDate, setEntryDate] = useState(today);
  const [dueDate, setDueDate] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // One key per form. A retry after a lost reply carries the same key, so it cannot record a second payment.
  const [requestKey] = useState(() => crypto.randomUUID());
  const id = `entry-${kind}`;
  const formRef = useAutoFocus<HTMLFormElement>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const cents = parseMoneyToCents(amount, { allowNegative: kind === "adjustment" });
    if (cents === null) return setError("Enter an amount in dollars, like 1250 or 1250.75.");
    if (kind === "writeoff" && cents > owedCents) {
      return setError(`You can write off at most ${formatCents(owedCents, { fixed: true })}, which is what is owed.`);
    }

    const parsed = ledgerEntrySchema.safeParse({
      type: TYPE_OF[kind],
      amountCents: cents,
      entryDate,
      dueDate: kind === "charge" || kind === "adjustment" ? dueDate || null : null,
      reference,
      note,
      requestKey,
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Check the amount and dates.");

    try {
      const { warning, duplicate, postDated } = await record.mutateAsync(parsed.data);
      if (duplicate) notify("That was already recorded, so nothing was added twice.");
      else if (postDated) notify("Recorded. It is dated in the future, so it will not count toward the balance until that day.");
      else if (warning === "over_limit") notify("Charge recorded. This account is now over its credit limit.", "err");
      else if (warning === "overpayment") notify("Payment recorded. The account now has a credit balance.");
      else notify(DONE[kind]);
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "Could not save. Please try again.");
    }
  }

  return (
    <form ref={formRef} className="inline-form" style={{ marginTop: 10 }} onSubmit={submit} noValidate aria-label={TITLE[kind]}>
      {error ? (
        <div className="form-error" role="alert" style={{ marginBottom: 0 }}>
          {error}
        </div>
      ) : null}
      <div className="row">
        <div className="col">
          <label htmlFor={`${id}-amount`}>{kind === "adjustment" ? "Amount ($, negative to reduce)" : "Amount ($)"}</label>
          <input id={`${id}-amount`} type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-autofocus aria-describedby={kind === "writeoff" ? `${id}-owed` : undefined} />
          {kind === "writeoff" ? (
            <span className="field-hint" id={`${id}-owed`}>
              Up to {formatCents(owedCents, { fixed: true })}, which is what is owed.
            </span>
          ) : null}
        </div>
        <div className="col">
          <label htmlFor={`${id}-date`}>Date</label>
          <input id={`${id}-date`} type="date" value={entryDate} max={kind === "writeoff" ? today : undefined} onChange={(e) => setEntryDate(e.target.value)} aria-describedby={entryDate > today ? `${id}-future` : undefined} />
          {entryDate > today ? (
            <span className="field-hint" id={`${id}-future`}>
              After today: it will not count toward the balance until that day.
            </span>
          ) : null}
        </div>
      </div>
      {kind === "charge" || kind === "adjustment" ? (
        <div className="col">
          <label htmlFor={`${id}-due`}>Due date (blank uses {paymentTerms})</label>
          <input id={`${id}-due`} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      ) : null}
      <div className="row">
        <div className="col">
          <label htmlFor={`${id}-ref`}>{kind === "payment" ? "Check / reference #" : "Invoice / reference #"}</label>
          <input id={`${id}-ref`} type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div className="col">
          <label htmlFor={`${id}-note`}>{kind === "writeoff" ? "Reason (required)" : "Note"}</label>
          <input id={`${id}-note`} type="text" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div className="actions">
        <button type="button" className="btn btn-sm" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={record.isPending}>
          {record.isPending ? "Saving…" : TITLE[kind]}
        </button>
      </div>
    </form>
  );
}
