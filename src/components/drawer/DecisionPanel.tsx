"use client";

import { useState, type FormEvent } from "react";
import { ApiClientError } from "@/lib/client/api";
import { useBusinessToday, useDecision } from "@/lib/client/queries";
import { focusDrawerTitle } from "../focus";
import { PAYMENT_TERMS } from "@/lib/domain/constants";
import { centsToDecimal } from "@/lib/domain/csv";
import { parseMoneyToCents } from "@/lib/domain/money";
import { availableDecisions } from "@/lib/domain/status";
import type { CustomerSummary } from "@/lib/types";
import { decisionSchema } from "@/lib/validation";
import { useAutoFocus } from "../useAutoFocus";
import { useToast } from "../Toast";
import { useUi } from "../ui-context";

interface Props {
  customer: CustomerSummary;
  active: string | null;
  setActive: (form: string | null) => void;
}

function useDecide(customer: CustomerSummary, done: () => void) {
  const notify = useToast();
  const decision = useDecision(customer.id);
  const [error, setError] = useState<string | null>(null);

  /** Returns whether the decision was recorded. */
  async function run(input: unknown, success: string): Promise<boolean> {
    setError(null);
    const parsed = decisionSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the details and try again.");
      return false;
    }
    try {
      await decision.mutateAsync(parsed.data);
      notify(success);
      done();
      return true;
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "Could not save. Please try again.");
      return false;
    }
  }
  return { run, fail: setError, error, pending: decision.isPending };
}

function ApproveForm({ customer, done }: { customer: CustomerSummary; done: () => void }) {
  const { run, fail, error, pending } = useDecide(customer, done);
  // The version this form was opened at. The drawer refreshes every 30 seconds; sending the NEWEST version would silently pass the
  // "someone else changed this" check for a change made while the form was open.
  const [openedVersion] = useState(customer.version);
  const [limit, setLimit] = useState(customer.requestedLimitCents ? centsToDecimal(customer.requestedLimitCents) : "");
  const [terms, setTerms] = useState(customer.paymentTerms);
  const today = useBusinessToday();
  const [start, setStart] = useState(today);
  const formRef = useAutoFocus<HTMLFormElement>();

  function submit(event: FormEvent) {
    event.preventDefault();
    const cents = parseMoneyToCents(limit);
    if (cents === null || cents <= 0) return fail("Enter a credit limit greater than 0, like 25000.");
    void run(
      { action: "approve", version: openedVersion, creditLimitCents: cents, paymentTerms: terms, creditStartDate: start },
      "Application approved.",
    );
  }

  return (
    <form ref={formRef} className="inline-form" style={{ marginTop: 10 }} onSubmit={submit} noValidate aria-label="Approve application">
      {error ? <div className="form-error" role="alert" style={{ marginBottom: 0 }}>{error}</div> : null}
      <div className="row">
        <div className="col">
          <label htmlFor="ap-limit">Credit limit ($)</label>
          <input id="ap-limit" type="text" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} data-autofocus />
        </div>
        <div className="col">
          <label htmlFor="ap-terms">Payment terms</label>
          <select id="ap-terms" value={terms} onChange={(e) => setTerms(e.target.value)}>
            {PAYMENT_TERMS.map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
      </div>
      <div className="col">
        <label htmlFor="ap-start">Credit start date</label>
        <input id="ap-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
      </div>
      <div className="actions">
        <button type="button" className="btn btn-sm" onClick={done}>Cancel</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={pending}>{pending ? "Saving…" : "Confirm approval"}</button>
      </div>
    </form>
  );
}

function ReasonForm({ customer, action, label, success, done }: {
  customer: CustomerSummary; action: "deny" | "suspend"; label: string; success: string; done: () => void;
}) {
  const { run, error, pending } = useDecide(customer, done);
  const [openedVersion] = useState(customer.version); // see ApproveForm
  const [reason, setReason] = useState("");
  const id = `reason-${action}`;
  const formRef = useAutoFocus<HTMLFormElement>();

  function submit(event: FormEvent) {
    event.preventDefault();
    void run({ action, version: openedVersion, reason }, success);
  }

  return (
    <form ref={formRef} className="inline-form" style={{ marginTop: 10 }} onSubmit={submit} noValidate aria-label={label}>
      {error ? <div className="form-error" role="alert" style={{ marginBottom: 0 }}>{error}</div> : null}
      <div className="col">
        <label htmlFor={id}>Reason (optional)</label>
        <input id={id} type="text" value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
      </div>
      <div className="actions">
        <button type="button" className="btn btn-sm" onClick={done}>Cancel</button>
        <button type="submit" className="btn btn-sm btn-danger" disabled={pending}>{pending ? "Saving…" : label}</button>
      </div>
    </form>
  );
}

function InstantAction({ customer, action, label, success, primary }: {
  customer: CustomerSummary; action: "start_review" | "reopen"; label: string; success: string; primary?: boolean;
}) {
  const { run, error, pending } = useDecide(customer, () => undefined);
  return (
    <>
      <button
        type="button"
        className={`btn btn-sm${primary ? " btn-primary" : ""}`}
        disabled={pending}
        // The button goes away once the status changes: move focus to the customer's name instead of dropping it on the page.
        onClick={() => void run({ action, version: customer.version }, success).then((recorded) => recorded && focusDrawerTitle())}
      >
        {label}
      </button>
      {error ? <span className="field-error" role="alert">{error}</span> : null}
    </>
  );
}

export function DecisionPanel({ customer, active, setActive }: Props) {
  const { user } = useUi();
  const { status } = customer;
  const close = () => setActive(null);
  // Exactly the decisions the workflow would accept for this status and this role: the screen and the server cannot disagree.
  const decisions = availableDecisions(status, user.role);

  const pendingApplication = status === "submitted" || status === "under_review";

  return (
    <div>
      {pendingApplication ? (
        <>
          <h3 className="kv-label" style={{ marginBottom: 8 }}>Approval process</h3>
          <div className="action-row">
            {decisions.includes("start_review") ? (
              <InstantAction customer={customer} action="start_review" label="Start review" success="Moved to under review." />
            ) : null}
            {decisions.includes("approve") ? (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setActive("approve")}>Approve</button>
            ) : null}
            {decisions.includes("deny") ? (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setActive("deny")}>Deny</button>
            ) : null}
            {!decisions.includes("approve") ? <span className="field-hint">An admin makes approval decisions.</span> : null}
          </div>
        </>
      ) : null}
      {decisions.includes("reopen") ? (
        <div className="action-row">
          <InstantAction customer={customer} action="reopen" label="Reopen for review" success="Reopened for review." />
        </div>
      ) : null}
      {decisions.includes("suspend") ? (
        <div className="action-row">
          <button type="button" className="btn btn-sm btn-danger" onClick={() => setActive("suspend")}>Suspend credit</button>
        </div>
      ) : null}

      {/* A form is shown only while its decision is still one the workflow would accept: if a colleague changed the status, it goes. */}
      {active === "approve" && decisions.includes("approve") ? <ApproveForm customer={customer} done={close} /> : null}
      {active === "deny" && decisions.includes("deny") ? <ReasonForm customer={customer} action="deny" label="Confirm denial" success="Application denied." done={close} /> : null}
      {active === "suspend" && decisions.includes("suspend") ? <ReasonForm customer={customer} action="suspend" label="Suspend credit" success="Credit suspended." done={close} /> : null}
    </div>
  );
}
