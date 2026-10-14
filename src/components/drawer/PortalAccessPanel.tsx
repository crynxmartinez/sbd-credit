"use client";

import { useState, type FormEvent } from "react";
import { ApiClientError } from "@/lib/client/api";
import { useInviteContact, usePortalContacts, useReinviteContact, useSetContactActive } from "@/lib/client/queries";
import type { ContactStatus } from "@/lib/domain/portal-users";
import type { PortalContactDto, PortalInviteResult } from "@/lib/types";
import { useAutoFocus } from "../useAutoFocus";
import { useToast } from "../Toast";

const STATUS_LABEL: Readonly<Record<ContactStatus, string>> = { invited: "Invited", active: "Active", disabled: "Turned off" };
const STATUS_BADGE: Readonly<Record<ContactStatus, string>> = { invited: "badge-under_review", active: "badge-approved", disabled: "badge-denied" };

const when = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** A freshly made invitation link. It lives in the drawer's memory only, so closing the drawer is what makes it unrecoverable. */
export interface IssuedLink {
  name: string;
  result: PortalInviteResult;
}

function LinkBox({ issued, onDismiss }: { issued: IssuedLink; onDismiss: () => void }) {
  const notify = useToast();
  // Focus moves to the link when it appears, which also makes a screen reader read what it is.
  const ref = useAutoFocus<HTMLDivElement>();

  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.result.link);
      notify("Link copied.");
    } catch {
      notify("Couldn't copy. Select the link and copy it by hand.", "err");
    }
  }

  return (
    <div ref={ref} className="portal-link-box" role="group" aria-label="Invitation link">
      <div>
        Send this link to <b>{issued.name}</b>. It works once and expires {when(issued.result.expiresAt)}. <b>It is shown only now</b>; if it is lost, send a new one.
      </div>
      <input
        type="text"
        readOnly
        value={issued.result.link}
        aria-label={`Invitation link for ${issued.name}`}
        onFocus={(event) => event.currentTarget.select()}
        data-autofocus
      />
      <div className="actions">
        <button type="button" className="btn btn-sm" onClick={onDismiss}>
          Done
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={copy}>
          Copy link
        </button>
      </div>
    </div>
  );
}

function AddContact({ customerId, onIssued, onCancel }: { customerId: string; onIssued: (issued: IssuedLink) => void; onCancel: () => void }) {
  const invite = useInviteContact(customerId);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const formRef = useAutoFocus<HTMLFormElement>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    // A second Enter must not make a second invitation, which would replace (and so cancel) the link just shown.
    if (invite.isPending) return;
    setError(null);
    try {
      onIssued({ name: name.trim(), result: await invite.mutateAsync({ name, email }) });
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "Could not create the invitation. Please try again.");
    }
  }

  return (
    <form ref={formRef} className="inline-form" onSubmit={submit} noValidate aria-label="Add a person">
      {error ? <div className="form-error" role="alert" style={{ marginBottom: 0 }}>{error}</div> : null}
      <div className="row">
        <div className="col">
          <label htmlFor="portal-name">Name</label>
          <input id="portal-name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" data-autofocus />
        </div>
        <div className="col">
          <label htmlFor="portal-email">Email</label>
          <input id="portal-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </div>
      </div>
      <div className="actions">
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={invite.isPending}>
          {invite.isPending ? "Creating…" : "Create invite link"}
        </button>
      </div>
    </form>
  );
}

function ContactRow({ customerId, contact, onIssued }: { customerId: string; contact: PortalContactDto; onIssued: (issued: IssuedLink) => void }) {
  const notify = useToast();
  const reinvite = useReinviteContact(customerId);
  const setActive = useSetContactActive(customerId);
  const [error, setError] = useState<string | null>(null);
  const busy = reinvite.isPending || setActive.isPending;

  async function run(action: () => Promise<unknown>, failure: string) {
    if (busy) return;
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : failure);
    }
  }

  const off = contact.status === "disabled";
  return (
    <li className="portal-contact">
      <div>
        <b>{contact.name}</b> <span className={`badge ${STATUS_BADGE[contact.status]}`}>{STATUS_LABEL[contact.status]}</span>
        <div className="ledger-sub">
          {contact.email} · {contact.lastLoginAt ? `last signed in ${when(contact.lastLoginAt)}` : "never signed in"}
          {contact.inviteExpiresAt ? ` · link valid until ${when(contact.inviteExpiresAt)}` : ""}
        </div>
        {error ? <div className="form-error" role="alert" style={{ marginTop: 6 }}>{error}</div> : null}
      </div>
      <div className="action-row">
        {off ? null : (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => run(async () => onIssued({ name: contact.name, result: await reinvite.mutateAsync(contact.id) }), "Could not send a new link.")}
            aria-label={`Send a new link to ${contact.name}`}
          >
            New link
          </button>
        )}
        <button
          type="button"
          className={`btn btn-sm${off ? "" : " btn-danger"}`}
          disabled={busy}
          onClick={() =>
            run(async () => {
              await setActive.mutateAsync({ contactId: contact.id, active: off });
              notify(off ? "Access turned on." : "Access turned off.");
            }, "Could not change access.")
          }
          aria-label={`${off ? "Turn on" : "Turn off"} access for ${contact.name}`}
        >
          {off ? "Turn on" : "Turn off"}
        </button>
      </div>
    </li>
  );
}

/**
 * Admins only: who at this customer may sign in to see their account, and the one-time links that let them.
 * The link being shown is held by the drawer, so the drawer can warn before it is closed with a link still on screen.
 */
export function PortalAccessPanel({ customerId, issued, onIssuedChange }: { customerId: string; issued: IssuedLink | null; onIssuedChange: (issued: IssuedLink | null) => void }) {
  const { data, isLoading, error, refetch } = usePortalContacts(customerId);
  const [adding, setAdding] = useState(false);

  function showLink(next: IssuedLink) {
    setAdding(false);
    onIssuedChange(next);
  }

  return (
    <div>
      <div className="kv-label" style={{ marginBottom: 8 }}>
        Customer portal
      </div>
      <p className="ledger-sub" style={{ marginTop: 0 }}>
        People who can sign in to see this customer&apos;s credit, balance and history.
      </p>

      {issued ? <LinkBox issued={issued} onDismiss={() => onIssuedChange(null)} /> : null}

      {isLoading ? <div className="skeleton" style={{ height: 40 }} /> : null}
      {error && !data ? (
        <div className="form-error" role="alert">
          {error.message}{" "}
          <button type="button" className="btn btn-sm" onClick={() => refetch()}>
            Retry
          </button>
        </div>
      ) : null}
      {data && data.length === 0 && !adding ? <div className="ledger-sub">No one has access yet.</div> : null}
      {data && data.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {data.map((contact) => (
            <ContactRow key={contact.id} customerId={customerId} contact={contact} onIssued={showLink} />
          ))}
        </ul>
      ) : null}

      {adding ? (
        <AddContact customerId={customerId} onIssued={showLink} onCancel={() => setAdding(false)} />
      ) : (
        <div className="action-row" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
            Add a person
          </button>
        </div>
      )}
    </div>
  );
}
