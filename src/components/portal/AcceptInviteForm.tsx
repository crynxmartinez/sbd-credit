"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiClientError, apiFetch } from "@/lib/client/api";
import { MIN_PASSWORD_LENGTH } from "@/lib/domain/users";
import { useAutoFocus } from "../useAutoFocus";
import { Field } from "../ui";

const TOKEN_IN_FRAGMENT = /^#t=([A-Za-z0-9_-]{43})$/;

type Stage = "reading" | "missing" | "form" | "done";

/** Shown when the password is set: focus moves to the way forward, because the form it came from is gone. */
function Done() {
  const ref = useAutoFocus<HTMLDivElement>();
  return (
    <div ref={ref} style={{ display: "contents" }}>
      <div className="ok-note" role="status">Your password is set. You can sign in now with your email address and that password.</div>
      <Link href="/login" className="btn btn-primary" data-autofocus>
        Go to sign in
      </Link>
    </div>
  );
}

export function AcceptInviteForm() {
  const [link, setLink] = useState<{ stage: Stage; token: string }>({ stage: "reading", token: "" });
  const { stage, token } = link;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const readLink = useRef(false);

  // Read the link's secret once, then take it out of the address bar so it is not left in the history or a screenshot.
  // React runs this effect twice in development; the second run would find the secret already gone, so it must not read again.
  useEffect(() => {
    if (readLink.current) return;
    readLink.current = true;
    const found = TOKEN_IN_FRAGMENT.exec(window.location.hash)?.[1];
    window.history.replaceState(null, "", window.location.pathname);
    setLink(found ? { stage: "form", token: found } : { stage: "missing", token: "" });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    // Pressing Enter twice would send the one-time link twice; the second send would then be told it was already used.
    if (pending) return;
    setError(null);
    if (password !== confirm) return setError("The two passwords do not match.");
    setPending(true);
    try {
      await apiFetch("/api/portal/accept", { method: "POST", body: { token, password } });
      setLink({ stage: "done", token: "" });
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "Could not save your password. Please try again.");
      setPending(false);
    }
  }

  return (
    <main className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <h1 className="brand-name" style={{ margin: 0 }}>
            STEEL BUILDING
            <br />
            DEPOT
          </h1>
          <div className="brand-sub">Set your password</div>
        </div>
        <div className="login-body">
          {stage === "reading" ? <div className="skeleton" style={{ height: 120 }} /> : null}

          {stage === "missing" ? (
            <div className="form-error" role="alert">
              This link is incomplete. Please open the whole link we sent you, or ask us to send a new one.
            </div>
          ) : null}

          {stage === "done" ? <Done /> : null}

          {stage === "form" ? (
            <form onSubmit={submit} noValidate style={{ display: "contents" }} aria-label="Set your password">
              {error ? (
                <div className="form-error" role="alert">
                  {error}
                </div>
              ) : null}
              <Field id="accept_password" label="New password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
                <input id="accept_password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
              </Field>
              <Field id="accept_confirm" label="Type it again">
                <input id="accept_confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
              </Field>
              <button type="submit" className="btn btn-primary" disabled={pending}>
                {pending ? "Saving…" : "Set password"}
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </main>
  );
}
