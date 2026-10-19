"use client";

import { newRequestKey } from "@/lib/client/request-key";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiClientError } from "@/lib/client/api";
import { chargeLabel, recordsFromDto } from "@/lib/client/ledger-records";
import { useBusinessToday, useRecordEntry } from "@/lib/client/queries";
import { MIN_REASON_LENGTH } from "@/lib/domain/constants";
import { entryDateProblem, entryDateWindow } from "@/lib/domain/entry-dates";
import { centsToDecimal } from "@/lib/domain/csv";
import { formatCents, parseMoneyToCents } from "@/lib/domain/money";
import { planWriteOffAllocation, writeOffTargets, type Allocation } from "@/lib/domain/write-off";
import type { LedgerEntryDto } from "@/lib/types";
import { ledgerEntrySchema } from "@/lib/validation";
import { useAutoFocus } from "../useAutoFocus";
import { useToast } from "../Toast";
import { useUi } from "../ui-context";

export type EntryKind = "payment" | "charge" | "adjustment" | "writeoff";

const TYPE_OF = { payment: "PAYMENT", charge: "CHARGE", adjustment: "ADJUSTMENT", writeoff: "WRITE_OFF" } as const;
const TITLE = { payment: "Record payment", charge: "Add charge", adjustment: "Post adjustment", writeoff: "Write off" } as const;
const DONE = { payment: "Payment recorded.", charge: "Charge added.", adjustment: "Adjustment posted.", writeoff: "Written off." } as const;

type Direction = "increase" | "reduce";
/** A write-off covers the oldest-due charges by default, or the ones the person picks. */
type CoverMode = "oldest" | "choose";

interface Props {
  customerId: string;
  kind: EntryKind;
  paymentTerms: string;
  /** What the customer owes now. */
  owedCents: number;
  /** The customer's ledger: a write-off is allocated to charges in it. */
  ledger: readonly LedgerEntryDto[];
  /** Only an approved account can be given more credit, so only then may an adjustment raise what is owed. */
  approved: boolean;
  onDone: () => void;
}

export function EntryForm({ customerId, kind, paymentTerms, owedCents, ledger, approved, onDone }: Props) {
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
  // Which charges a write-off covers. "picked" holds the amount typed for each charge that is ticked.
  const [mode, setMode] = useState<CoverMode>("oldest");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [reviewedCover, setReviewedCover] = useState<Allocation[]>([]);
  // One key per form. A retry after a lost reply carries the same key, so it cannot record a second payment.
  const [requestKey] = useState(() => newRequestKey());
  const id = `entry-${kind}`;
  const records = useMemo(() => recordsFromDto(ledger), [ledger]);
  const entryById = useMemo(() => new Map(ledger.map((entry) => [entry.id, entry])), [ledger]);
  // Exactly the charges the server will accept for a write-off on this date: the same rule, from the same module.
  const targets = useMemo(() => (kind === "writeoff" ? writeOffTargets(records, entryDate, today) : []), [kind, records, entryDate, today]);
  const writableCents = targets.reduce((sum, target) => sum + target.openCents, 0);
  const formRef = useAutoFocus<HTMLFormElement>();
  const reviewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (reviewing) reviewRef.current?.focus();
  }, [reviewing]);

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
    let cover: Allocation[] | undefined;
    if (kind === "writeoff") {
      if (reviewing && reviewedCover.length > 0) {
        // The second press sends EXACTLY what the review showed, even if a refresh has since changed what is open: the server
        // checks it, and says so if it no longer fits. Recomputing here could record a different split than the one approved.
        cover = reviewedCover;
      } else {
        const chosen = mode === "choose" ? Object.entries(picked).map(([chargeId, text]) => ({ chargeId, amountCents: parseMoneyToCents(text) ?? 0 })) : undefined;
        const plan = planWriteOffAllocation(cents, targets, chosen);
        if (!plan.ok) {
          if (plan.code === "nothing_owed") return setError("Nothing is owed, so there is nothing to write off.");
          if (plan.code === "exceeds_balance") return setError(`You can write off at most ${formatCents(plan.maxCents, { fixed: true })}, which is what is owed.`);
          return setError("The amounts picked for the charges must add up to the write-off amount, and no charge can take more than is open on it.");
        }
        cover = plan.allocations;
      }
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
      // What was reviewed is what is sent, so a payment arriving meanwhile cannot change which charges are covered unseen.
      ...(cover ? { allocations: cover } : {}),
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Check the amount and dates.");

    if (kind === "writeoff" && !reviewing) {
      setReviewedCover(cover ?? []);
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
        <div className="form-error" role="alert" id={`${id}-error`} style={{ marginBottom: 0 }}>
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
            aria-invalid={error ? true : undefined}
            aria-describedby={[kind === "writeoff" ? `${id}-owed` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined}
          />
          {kind === "writeoff" ? (
            <span className="field-hint" id={`${id}-owed`}>
              Up to {formatCents(writableCents, { fixed: true })}, which is what is owed.
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
      {kind === "writeoff" ? (
        <fieldset className="direction">
          <legend>Which charges does this cover?</legend>
          <label>
            <input type="radio" name={`${id}-cover`} checked={mode === "oldest"} onChange={() => edit(setMode)("oldest")} />
            The oldest charges first
          </label>
          <label>
            <input type="radio" name={`${id}-cover`} checked={mode === "choose"} onChange={() => edit(setMode)("choose")} />
            I will choose the charges
          </label>
          {mode === "choose" ? (
            targets.length === 0 ? (
              <span className="field-hint">No charge has anything open on this date.</span>
            ) : (
              <ul className="pick-list">
                {targets.map((target) => {
                  const label = chargeLabel(entryById.get(target.id));
                  const on = target.id in picked;
                  return (
                    <li key={target.id} className="pick-row">
                      <label>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            setReviewing(false);
                            setPicked((current) => {
                              const others = Object.fromEntries(Object.entries(current).filter(([chargeId]) => chargeId !== target.id));
                              return e.target.checked ? { ...others, [target.id]: centsToDecimal(target.openCents) } : others;
                            });
                          }}
                        />
                        {label} — {formatCents(target.openCents, { fixed: true })} open
                      </label>
                      {on ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          className="pick-amount"
                          value={picked[target.id]}
                          aria-label={`Amount to write off on ${label}`}
                          onChange={(e) => {
                            setReviewing(false);
                            setPicked((current) => ({ ...current, [target.id]: e.target.value }));
                          }}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )
          ) : null}
        </fieldset>
      ) : null}
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
        // Focus moves here when the review appears: the confirmation step of a financial action must be read out, and a status
        // region inserted with its text already in it is not announced by every screen reader.
        <div className="warn-note" role="group" aria-label="Review this write-off" tabIndex={-1} ref={reviewRef}>
          This gives up on {formatCents(cents, { fixed: true })} of the {formatCents(owedCents, { fixed: true })} owed. The balance becomes{" "}
          <b>{formatCents(owedCents - cents, { fixed: true })}</b>, and it stops showing as past due. It can be undone only by reversing the write-off.
          <ul className="pick-list" aria-label="Charges this covers">
            {reviewedCover.map((item) => (
              <li key={item.chargeId}>
                Covers {chargeLabel(entryById.get(item.chargeId))}: {formatCents(item.amountCents, { fixed: true })}
              </li>
            ))}
          </ul>
          Those charges cannot be voided or reversed until this write-off is reversed.
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
