"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client/api";
import { useToast } from "./Toast";
import type { SessionUser } from "@/lib/types";
import { CustomersIcon, DashboardIcon, SignOutIcon } from "./icons";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { href: "/", label: "Dashboard", Icon: DashboardIcon },
  { href: "/customers", label: "Customers", Icon: CustomersIcon },
] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const letters = `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  return letters || "?";
}

const ROLE_LABEL = { EMPLOYEE: "Employee", ADMIN: "Admin", SUPERADMIN: "Super admin" } as const;

function useSignOut() {
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
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load also clears the previous user's cached data
    window.location.assign("/login");
  }
  return { signOut, signingOut };
}

export function Sidebar({ user }: { user: SessionUser }) {
  const pathname = usePathname();
  const { signOut, signingOut } = useSignOut();

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-name">
          STEEL BUILDING
          <br />
          DEPOT
        </div>
        <div className="brand-sub">Credit Application Tracker</div>
      </div>
      <nav aria-label="Main" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {NAV.map(({ href, label, Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link key={href} href={href} className={`nav-btn${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
              <Icon />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-tools">
          <ThemeToggle />
          <button type="button" className="nav-btn as-button" onClick={signOut} disabled={signingOut}>
            <SignOutIcon />
            Sign out
          </button>
        </div>
        <div className="whoami">
          <div className="avatar" aria-hidden="true">
            {initials(user.name)}
          </div>
          <div>
            <div style={{ fontSize: "12.5px", color: "#D7E1F0" }}>{user.name}</div>
            <div>{ROLE_LABEL[user.role]}</div>
          </div>
        </div>
        Changes made by others appear within about 30 seconds.
      </div>
    </aside>
  );
}

/** Under 860px the sidebar is hidden, so navigation, theme and sign-out all live in this strip. */
export function MobileNav({ user }: { user: SessionUser }) {
  const pathname = usePathname();
  const { signOut, signingOut } = useSignOut();
  return (
    <nav className="mobile-topnav" aria-label="Main">
      {NAV.map(({ href, label }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link key={href} href={href} className={`pill${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
            {label}
          </Link>
        );
      })}
      <ThemeToggle variant="pill" />
      <button type="button" className="pill" onClick={signOut} disabled={signingOut}>
        Sign out ({user.name.split(" ")[0]})
      </button>
    </nav>
  );
}
