"use client";

import { useState, type FormEvent } from "react";
import { ApiClientError } from "@/lib/client/api";
import { useBusinessToday, useRecordEntry } from "@/lib/client/queries";
import { MIN_REASON_LENGTH } from "@/lib/domain/constants";
import { entryDateProblem, entryDateWindow } from "@/lib/domain/entry-dates";
import { formatCents, parseMoneyToCents } from "@/lib/domain/money";
import { ledgerEntrySchema } from "@/lib/validation";
import { useAutoFocus } from "../useAutoFocus";
import { useToast } from "../Toast";
import { useUi } from "../ui-context";

export type EntryKind = "payment" | "charge" | "adjustment" | "writeoff";

const TYPE_OF = { payment: "PAYMENT", charge: "CHARGE", adjustment: "ADJUSTMENT", writeoff: "WRITE_OFF" } as const;
const TITLE = { payment: "Record payment", charge: "Add charge", adjustment: "Post adjustment", writeoff: "Write off" } as const;
const DONE = { payment: "Payment recorded.", charge: "Charge added.", adjustment: "Adjustment posted.", writeoff: "Written off." } as const;

type Direction = "increase" | "reduce";

interface Props {
  customerId: string;
  kind: EntryKind;
  paymentTerms: string;
  /** What the customer owes now. A write-off cannot exceed it. */
  owedCents: number;
  /** Only an approved account can be given more credit, so only then may an adjustment raise what is owed. */
  approved: boolean;
  onDone: () => void;
}

export function EntryForm({ customerId, kind, paymentTerms, owedCents, approved, onDone }: Props) {
  const { user } = useUi();
  const notify = useToast();
  const record = useRecordEntry(customerId);
  const today = useBusinessToday();
  const window_ = entryDateWindow(user.role, today);
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<Direction>("reduce");
  const [entryDate, setEntryDate] = useState(today);
  const [dueDate, setDueDate] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A write-off is hard to take back, so it has a review step: the first press shows what will happen, the second does it.
  const [reviewing, setReviewing] = useState(false);
  // One key per form. A retry after a lost reply carries the same key, so it cannot record a second payment.
  const [requestKey] = useState(() => crypto.randomUUID());
  const id = `entry-${kind}`;
  const formRef = useAutoFocus<HTMLFormElement>();

  // Any change to what was typed cancels the review, so the summary can never describe something other than what is sent.
  const edit = <T,>(setter: (value: T) => void) => (value: T) => {
    setReviewing(false);
    setter(value);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    // Pressing Enter twice must not send it twice.
    if (record.isPending) return;
    setError(null);

    const cents = parseMoneyToCents(amount);
    if (cents === null || cents === 0) return setError("Enter an amount in dollars, like 1250 or 1250.75.");
    const dateProblem = entryDateProblem(user.role, entryDate, today) ?? (kind === "writeoff" && entryDate > today ? "A write-off cannot be dated in the future." : null);
    if (dateProblem) return setError(dateProblem);
    if (kind === "writeoff") {
      if (cents > owedCents) return setError(`You can write off at most ${formatCents(owedCents, { fixed: true })}, which is what is owed.`);
      if (note.trim().length < MIN_REASON_LENGTH) return setError("Say why this is being written off.");
    }

    const signed = kind === "adjustment" && direction === "reduce" ? -cents : cents;
    const parsed = ledgerEntrySchema.safeParse({
      type: TYPE_OF[kind],
      amountCents: signed,
      entryDate,
      dueDate: kind === "charge" || kind === "adjustment" ? dueDate || null : null,
      reference,
      note,
      requestKey,
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Check the amount and dates.");

    if (kind === "writeoff" && !reviewing) {
      setReviewing(true);
      return;
    }

    try {
      const { warning, duplicate, postDated } = await record.mutateAsync(parsed.data);
      if (duplicate) notify("That was already recorded, so nothing was added twice.");
      else if (postDated) notify("Recorded. It is dated in the future, so it will not count toward the balance until that day.");
      else if (warning === "over_limit") notify("Recorded. This account is now over its credit limit.", "err");
      else if (warning === "overpayment") notify("Payment recorded. The account now has a credit balance.");
      else notify(DONE[kind]);
      onDone();
    } catch (caught) {
      setReviewing(false);
      setError(caught instanceof ApiClientError ? caught.message : "Could not save. Please try again.");
    }
  }

  const cents = parseMoneyToCents(amount);
  const submitLabel = kind === "writeoff" ? (reviewing ? "Confirm write-off" : "Review write-off") : TITLE[kind];

  return (
    <form ref={formRef} className="inline-form" style={{ marginTop: 10 }} onSubmit={submit} noValidate aria-label={TITLE[kind]}>
      {error ? (
        <div className="form-error" role="alert" style={{ marginBottom: 0 }}>
          {error}
        </div>
      ) : null}

      {kind === "adjustment" ? (
        <fieldset className="direction">
          <legend>What does this do to the balance?</legend>
          <label>
            <input type="radio" name={`${id}-direction`} checked={direction === "reduce"} onChange={() => edit(setDirection)("reduce")} />
            Reduce what is owed
          </label>
          <label>
            <input type="radio" name={`${id}-direction`} checked={direction === "increase"} disabled={!approved} onChange={() => edit(setDirection)("increase")} />
            Increase what is owed{approved ? "" : " (approved accounts only)"}
          </label>
        </fieldset>
      ) : null}

      <div className="row">
        <div className="col">
          <label htmlFor={`${id}-amount`}>Amount ($)</label>
          <input
            id={`${id}-amount`}
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => edit(setAmount)(e.target.value)}
            data-autofocus
            aria-describedby={kind === "writeoff" ? `${id}-owed` : undefined}
          />
          {kind === "writeoff" ? (
            <span className="field-hint" id={`${id}-owed`}>
              Up to {formatCents(owedCents, { fixed: true })}, which is what is owed.
            </span>
          ) : null}
        </div>
        <div className="col">
          <label htmlFor={`${id}-date`}>Date</label>
          <input
            id={`${id}-date`}
            type="date"
            value={entryDate}
            min={window_.min ?? undefined}
            max={kind === "writeoff" ? today : window_.max}
            onChange={(e) => edit(setEntryDate)(e.target.value)}
            aria-describedby={entryDate > today ? `${id}-future` : undefined}
          />
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
          <input id={`${id}-due`} type="date" value={dueDate} onChange={(e) => edit(setDueDate)(e.target.value)} />
        </div>
      ) : null}
      <div className="row">
        <div className="col">
          <label htmlFor={`${id}-ref`}>{kind === "payment" ? "Check / reference #" : "Invoice / reference #"}</label>
          <input id={`${id}-ref`} type="text" value={reference} onChange={(e) => edit(setReference)(e.target.value)} aria-describedby={kind === "charge" || kind === "payment" ? `${id}-ref-hint` : undefined} />
          {kind === "charge" || kind === "payment" ? (
            <span className="field-hint" id={`${id}-ref-hint`}>
              The customer sees this on their page.
            </span>
          ) : null}
        </div>
        <div className="col">
          <label htmlFor={`${id}-note`}>{kind === "writeoff" ? "Reason (required)" : "Note (staff only)"}</label>
          <input id={`${id}-note`} type="text" value={note} onChange={(e) => edit(setNote)(e.target.value)} aria-required={kind === "writeoff" ? true : undefined} />
        </div>
      </div>

      {reviewing && cents !== null ? (
        <div className="warn-note" role="status">
          This gives up on {formatCents(cents, { fixed: true })} of the {formatCents(owedCents, { fixed: true })} owed. The balance becomes{" "}
          <b>{formatCents(owedCents - cents, { fixed: true })}</b>, and it stops showing as past due. It can be undone only by reversing the write-off.
        </div>
      ) : null}

      <div className="actions">
        <button type="button" className="btn btn-sm" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className={`btn btn-sm ${kind === "writeoff" ? "btn-danger" : "btn-primary"}`} disabled={record.isPending}>
          {record.isPending ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
