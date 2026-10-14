"use client";

import { useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/client/api";
import { SignOutIcon } from "../icons";
import { ThemeToggle } from "../ThemeToggle";
import { useToast } from "../Toast";

/** The customer's page frame: brand, who they are, theme and sign-out. Same look as the staff app, none of its navigation. */
export function PortalShell({ name, children }: { name: string; children: ReactNode }) {
  const notify = useToast();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Leaving for the sign-in page anyway would look like success while the session stayed alive.
      notify("Couldn't sign out. Please try again.", "err");
      setSigningOut(false);
      return;
    }
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load also clears cached data
    window.location.assign("/login");
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="portal-header">
        <div className="portal-brand">
          <div className="brand-name">
            STEEL BUILDING
            <br />
            DEPOT
          </div>
          <div className="brand-sub">My credit account</div>
        </div>
        <div className="portal-tools">
          <span className="portal-who">{name}</span>
          <ThemeToggle variant="pill" />
          <button type="button" className="pill" onClick={signOut} disabled={signingOut}>
            <SignOutIcon /> Sign out
          </button>
        </div>
      </header>
      <main className="portal-main" id="main" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
