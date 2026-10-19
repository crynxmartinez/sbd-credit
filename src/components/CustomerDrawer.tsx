"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { useBackGuard } from "@/lib/client/back-guard";
import { safeHref } from "@/lib/client/links";
import { ApiClientError } from "@/lib/client/api";
import { useCustomerDetail } from "@/lib/client/queries";
import { formatDate } from "@/lib/domain/dates";
import { formatCents } from "@/lib/domain/money";
import { canInviteTo } from "@/lib/domain/portal-users";
import { can } from "@/lib/domain/roles";
import { showsCreditPanel } from "@/lib/domain/status";
import { CreditPanel } from "./drawer/CreditPanel";
import { DecisionPanel } from "./drawer/DecisionPanel";
import { HistoryList } from "./drawer/HistoryList";
import { PortalAccessPanel, type IssuedLink } from "./drawer/PortalAccessPanel";
import { LedgerList } from "./drawer/LedgerList";
import { DataStatus } from "./DataStatus";
import { CloseIcon } from "./icons";
import { StatusBadge } from "./ui";
import { useUi } from "./ui-context";
import { useDialog } from "./useDialog";

type Tab = "ledger" | "history";
const TABS: readonly Tab[] = ["ledger", "history"];

function Kv({ label, value, full }: { label: string; value: string; full?: boolean }) {
  return (
    <div className={`kv${full ? " full" : ""}`}>
      <div className="kv-label">{label}</div>
      <div className="kv-value">{value}</div>
    </div>
  );
}

export function CustomerDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { user, openEdit } = useUi();
  // An invitation link is shown once and cannot be recovered, so closing the drawer with one on screen asks first.
  const [issuedLink, setIssuedLink] = useState<IssuedLink | null>(null);
  // One inline form open at a time, across the credit and decision panels.
  const [activeForm, setActiveForm] = useState<string | null>(null);
  function requestClose() {
    if (issuedLink && !window.confirm("The invitation link on screen is shown only once and cannot be shown again. Close anyway?")) return;
    if (activeForm !== null && !window.confirm("You have a form open that has not been saved. Close anyway?")) return;
    onClose();
  }
  const dialogRef = useDialog(requestClose);
  // The browser's Back button is a third way out of this drawer, besides the Close button and Escape: ask there too.
  useBackGuard({
    active: issuedLink !== null || activeForm !== null,
    message: () =>
      issuedLink ? "The invitation link on screen is shown only once and cannot be shown again. Leave anyway?" : "You have a form open that has not been saved. Leave anyway?",
  });
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useCustomerDetail(id);
  const gone = error instanceof ApiClientError && error.status === 404;
  const [tab, setTab] = useState<Tab>("ledger");
  const pressedBackdrop = useRef(false);

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.indexOf(tab);
    const target =
      event.key === "ArrowRight" ? (index + 1) % TABS.length
      : event.key === "ArrowLeft" ? (index - 1 + TABS.length) % TABS.length
      : event.key === "Home" ? 0
      : event.key === "End" ? TABS.length - 1
      : null;
    if (target === null) return;
    event.preventDefault();
    const next = TABS[target]!;
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  }

  const customer = data?.customer;
  const link = safeHref(customer?.accountingProjectUrl);

  return (
    <div
      className="drawer-overlay"
      // Closes on the click, not the press, and only if the press began on the backdrop too: a press that starts inside the drawer
      // and is dragged out (selecting text) must not close it, and a mis-press can be cancelled by moving away.
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressedBackdrop.current) requestClose();
      }}
    >
      <div ref={dialogRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" aria-busy={isLoading || undefined} tabIndex={-1}>
        <div className="sr-only" role="status">
          {customer ? `${customer.businessName} loaded.` : ""}
        </div>
        <div className="drawer-header">
          <div className="drawer-header-top">
            <div>
              {customer ? <StatusBadge status={customer.status} /> : null}
              <h2 className="drawer-title" id="drawer-title" tabIndex={-1}>
                {customer?.businessName ?? (gone ? "Customer not found" : error ? "Couldn't load this customer" : "Loading…")}
              </h2>
            </div>
            <button type="button" className="icon-btn" onClick={requestClose} aria-label="Close customer details">
              <CloseIcon />
            </button>
          </div>
          {customer ? (
            <div className="action-row" style={{ marginTop: 10 }}>
              {can(user.role, "customer.edit") ? (
                <button type="button" className="btn btn-sm" onClick={() => openEdit(customer)}>
                  Edit
                </button>
              ) : null}
              {link ? (
                <a className="btn btn-sm" href={link} target="_blank" rel="noopener noreferrer">
                  Open in {customer.accountingAppName || "accounting app"} ↗
                </a>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="drawer-body">
          {isLoading ? (
            <>
              <div className="skeleton" style={{ height: 90 }} />
              <div className="skeleton" style={{ height: 140 }} />
            </>
          ) : null}
          {error && !data ? (
            <div className="form-error" role="alert">
              {error.message}
              {gone ? null : (
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="btn btn-sm" onClick={() => refetch()}>
                    Retry
                  </button>
                </div>
              )}
            </div>
          ) : null}

          {/* If a refresh fails the figures below are old: say how old, instead of showing them as current. */}
          {data ? <DataStatus what="this customer" query={{ isError, error, dataUpdatedAt, hasData: true, refetch }} /> : null}

          {customer && data ? (
            <>
              {/* A credit line, or ANY account that still owes or is owed money (a denied or reopened customer who has not paid). */}
              {showsCreditPanel(customer.status, customer.balanceCents) ? (
                <CreditPanel customer={customer} ledger={data.ledger} active={activeForm} setActive={setActiveForm} />
              ) : null}
              <DecisionPanel customer={customer} active={activeForm} setActive={setActiveForm} />
              {can(user.role, "portal.manage") && canInviteTo(customer.status) ? <PortalAccessPanel customerId={customer.id} issued={issuedLink} onIssuedChange={setIssuedLink} /> : null}

              <div>
                <h3 className="kv-label" style={{ marginBottom: 8 }}>Details</h3>
                <div className="kv-grid">
                  <Kv label="Contact" value={customer.contactName || "—"} />
                  <Kv label="Phone" value={customer.phone || "—"} />
                  <Kv label="Email" value={customer.email || "—"} full />
                  <Kv label="Billing address" value={customer.billingAddress || "—"} full />
                  <Kv label="Date applied" value={formatDate(customer.dateApplied)} />
                  <Kv label="Requested limit" value={customer.requestedLimitCents ? formatCents(customer.requestedLimitCents) : "—"} />
                  <Kv label="Credit start date" value={formatDate(customer.creditStartDate)} />
                  <Kv label="Payment terms" value={customer.paymentTerms || "—"} />
                </div>
              </div>

              {customer.notes ? (
                <div>
                  <h3 className="kv-label" style={{ marginBottom: 6 }}>Notes</h3>
                  <div className="kv-value" style={{ whiteSpace: "pre-wrap", color: "var(--text-dim)" }}>{customer.notes}</div>
                </div>
              ) : null}

              <div>
                <div className="tabs" role="tablist" aria-label="Customer activity" onKeyDown={onTabKeyDown}>
                  {TABS.map((name) => (
                    <button
                      key={name}
                      type="button"
                      role="tab"
                      id={`tab-${name}`}
                      aria-selected={tab === name}
                      aria-controls="drawer-tabpanel"
                      tabIndex={tab === name ? 0 : -1}
                      className="tab"
                      onClick={() => setTab(name)}
                    >
                      {name === "ledger" ? `Ledger (${data.ledger.length})` : "History"}
                    </button>
                  ))}
                </div>
                <div role="tabpanel" id="drawer-tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
                  {tab === "ledger" ? <LedgerList customerId={customer.id} ledger={data.ledger} /> : <HistoryList audit={data.audit} />}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
