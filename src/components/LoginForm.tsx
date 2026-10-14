"use client";

import { useState, type FormEvent } from "react";
import { ApiClientError, apiFetch } from "@/lib/client/api";
import { safeNextFor, type SignInKind } from "@/lib/safe-next";
import { Field } from "./ui";

interface SignedIn {
  kind: SignInKind;
}

/** One sign-in page for staff and customers. The server says which kind of person signed in; that decides where they land. */
export function LoginForm({ next, unavailable = false }: { next?: string; unavailable?: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const who = await apiFetch<SignedIn>("/api/auth/login", { method: "POST", body: { username, password } });
      // A full load, so the server renders the signed-in app with the new session cookie.
      window.location.assign(safeNextFor(who.kind, next));
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "Could not sign in. Please try again.");
      setPending(false);
    }
  }

  return (
    <main className="login-wrap">
      <form className="login-card" onSubmit={submit} noValidate aria-labelledby="login-title">
        <div className="login-brand">
          <h1 className="brand-name" id="login-title" style={{ margin: 0 }}>
            STEEL BUILDING
            <br />
            DEPOT
          </h1>
          <div className="brand-sub">Credit · Sign in</div>
        </div>
        <div className="login-body">
          {unavailable ? (
            <div className="warn-note" role="status">
              The system is temporarily unavailable. You can try to sign in, but it may not work until it is back.
            </div>
          ) : null}
          {error ? (
            <div className="form-error" role="alert">
              {error}
            </div>
          ) : null}
          <Field id="login_username" label="Username or email">
            <input id="login_username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
          </Field>
          <Field id="login_password" label="Password">
            <input id="login_password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </main>
  );
}
