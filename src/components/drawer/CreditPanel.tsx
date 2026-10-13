"use client";

import { formatCents } from "@/lib/domain/money";
import { formatDate } from "@/lib/domain/dates";
import { can } from "@/lib/domain/roles";
import type { CustomerSummary } from "@/lib/types";
import { UtilBar } from "../ui";
import { useUi } from "../ui-context";
import { EntryForm, type EntryKind } from "./EntryForm";

interface Props {
  customer: CustomerSummary;
  active: string | null;
  setActive: (form: string | null) => void;
}

export function CreditPanel({ customer, active, setActive }: Props) {
  const { user } = useUi();
  const approved = customer.status === "approved";
  const entryKind = (["payment", "charge", "adjustment"] as const).find((kind) => kind === active) as EntryKind | undefined;

  return (
    <div>
      <div className="kv-label" style={{ marginBottom: 8 }}>
        Credit account
      </div>
      <div className="balance-box">
        <div>
          <div className="kv-label">Outstanding balance</div>
          <div className="balance-big">{formatCents(customer.balanceCents, { fixed: true })}</div>
        </div>
        <div>
          <div className="kv-label">Credit limit</div>
          <div className="balance-big">{formatCents(customer.creditLimitCents)}</div>
        </div>
        {approved ? (
          <div style={{ gridColumn: "1 / -1" }}>
            <UtilBar pct={customer.utilizationPct} level={customer.utilizationLevel} wide />
          </div>
        ) : null}
        <div>
          <div className="kv-label">Past due</div>
          <div className="kv-value mono" style={customer.overdueCents > 0 ? { color: "var(--red)" } : undefined}>
            {formatCents(customer.overdueCents, { fixed: true })}
          </div>
        </div>
        <div>
          <div className="kv-label">Next payment due</div>
          <div className="kv-value">{customer.nextDueDate ? `${formatDate(customer.nextDueDate)} · ${formatCents(customer.nextDueCents)}` : "—"}</div>
        </div>
        {customer.creditCents > 0 ? (
          <div style={{ gridColumn: "1 / -1" }} className="kv-value">
            Unapplied credit: <span className="mono">{formatCents(customer.creditCents, { fixed: true })}</span>
          </div>
        ) : null}
      </div>
      {can(user.role, "ledger.record") ? (
        <div className="action-row" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setActive("payment")}>
            Record payment
          </button>
          {approved ? (
            <button type="button" className="btn btn-sm" onClick={() => setActive("charge")}>
              Add charge
            </button>
          ) : null}
          {can(user.role, "ledger.adjust") ? (
            <button type="button" className="btn btn-sm" onClick={() => setActive("adjustment")}>
              Adjustment
            </button>
          ) : null}
        </div>
      ) : null}
      {entryKind ? (
        <EntryForm key={entryKind} customerId={customer.id} kind={entryKind} paymentTerms={customer.paymentTerms} onDone={() => setActive(null)} />
      ) : null}
    </div>
  );
}
