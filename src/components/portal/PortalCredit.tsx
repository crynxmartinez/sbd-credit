import { utilizationLevel } from "@/lib/domain/alerts";
import { formatDate } from "@/lib/domain/dates";
import { formatCents } from "@/lib/domain/money";
import { PORTAL_ENTRY_LIMIT, type PortalEntry, type PortalEntryKind, type PortalView } from "@/lib/domain/portal";
import { UtilBar } from "../ui";
import { PrintButton } from "./PrintButton";

const KIND_LABEL: Readonly<Record<PortalEntryKind, string>> = {
  purchase: "Purchase",
  payment: "Payment",
  credit: "Credit applied",
  correction: "Correction",
};

function StandingNotice({ standing }: { standing: PortalView["standing"] }) {
  if (standing === "active") return null;
  const text =
    standing === "on_hold"
      ? "Your credit is on hold, so new purchases on account are paused. Please contact us to get it sorted out."
      : "Your account is being reviewed. We will be in touch as soon as there is a decision.";
  return <div className="warn-note">{text}</div>;
}

function Fact({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="portal-fact">
      <dt className="kv-label">{label}</dt>
      <dd className="kv-value mono" style={alert ? { color: "var(--red)" } : undefined}>
        {value}
      </dd>
    </div>
  );
}

function EntryRow({ entry }: { entry: PortalEntry }) {
  const reduces = entry.amountCents < 0;
  const details = [formatDate(entry.date), entry.reference, entry.dueDate ? `due ${formatDate(entry.dueDate)}` : null].filter(Boolean);
  return (
    <li className="ledger-item">
      <div className="ledger-main">{KIND_LABEL[entry.kind]}</div>
      <div className={`ledger-amount${reduces ? " pay" : ""}`}>
        {reduces ? "−" : "+"}
        {formatCents(Math.abs(entry.amountCents), { fixed: true })}
      </div>
      <div className="ledger-sub">{details.join(" · ")}</div>
    </li>
  );
}

/** A customer's own credit account: what they can still buy, what they owe and when, and what has happened. */
export function PortalCredit({ view }: { view: PortalView }) {
  const level = utilizationLevel(view.utilizationPct);
  const active = view.standing === "active";

  return (
    <div className="portal-stack">
      <div className="portal-title-row">
        <div>
          <h1 className="page-title">{view.businessName}</h1>
          <div className="page-sub">Your credit account with Steel Building Depot, as of {formatDate(view.asOf)}.</div>
        </div>
        <PrintButton />
      </div>

      <StandingNotice standing={view.standing} />

      <section className="portal-card portal-hero" aria-labelledby="available-label">
        <h2 className="kv-label" id="available-label" style={{ margin: 0 }}>
          Available to purchase on credit
        </h2>
        <div className="portal-available">{formatCents(view.availableCents, { fixed: true })}</div>
        {active ? <UtilBar pct={view.utilizationPct} level={level} wide /> : null}
        <dl className="portal-facts">
          <Fact label="Credit limit" value={view.creditLimitCents > 0 ? formatCents(view.creditLimitCents) : "—"} />
          <Fact label="You owe" value={formatCents(Math.max(0, view.balanceCents), { fixed: true })} />
          <Fact label="Payment terms" value={view.paymentTerms} />
        </dl>
      </section>

      <section className="portal-card" aria-labelledby="due-label">
        <h2 className="section-heading" id="due-label">
          What&apos;s due
        </h2>
        <dl className="portal-facts">
          <Fact label="Past due" value={formatCents(view.overdueCents, { fixed: true })} alert={view.overdueCents > 0} />
          <Fact
            label="Next payment due"
            value={view.nextDueDate ? `${formatDate(view.nextDueDate)} · ${formatCents(view.nextDueCents, { fixed: true })}` : "—"}
          />
          {view.creditCents > 0 ? <Fact label="Credit on your account" value={formatCents(view.creditCents, { fixed: true })} /> : null}
        </dl>
        {view.overdueCents > 0 ? (
          <p className="page-sub" style={{ marginTop: 10 }}>
            Your oldest past-due amount is {view.oldestOverdueDays} {view.oldestOverdueDays === 1 ? "day" : "days"} late.
          </p>
        ) : null}
      </section>

      <section className="portal-card" aria-labelledby="history-label">
        <h2 className="section-heading" id="history-label">
          Your purchases and payments
        </h2>
        {view.entries.length === 0 ? (
          <div className="ledger-empty">Nothing yet.</div>
        ) : (
          <ul className="portal-ledger">
            {view.entries.map((entry, index) => (
              <EntryRow key={`${entry.date}-${index}`} entry={entry} />
            ))}
          </ul>
        )}
        {view.entries.length >= PORTAL_ENTRY_LIMIT ? (
          <p className="page-sub">Showing your most recent {PORTAL_ENTRY_LIMIT} entries.</p>
        ) : null}
      </section>
    </div>
  );
}
