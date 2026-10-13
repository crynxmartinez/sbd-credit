"use client";

import { useEffect, useSyncExternalStore } from "react";

type Preference = "system" | "light" | "dark";
const STORAGE_KEY = "credit-theme";
const NEXT: Readonly<Record<Preference, Preference>> = { system: "light", light: "dark", dark: "system" };
const LABEL: Readonly<Record<Preference, string>> = { system: "System", light: "Light", dark: "Dark" };

function apply(preference: Preference): void {
  const dark = preference === "dark" || (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

function readStored(): Preference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

// The preference lives in localStorage; this tiny store lets React read it without a mismatch between server and browser.
const listeners = new Set<() => void>();
function notify(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changed the preference: show it here too, not just in the label.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    apply(readStored());
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function save(preference: Preference): void {
  try {
    if (preference === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Storage can be blocked; the choice still applies for this visit.
  }
  apply(preference);
  notify();
}

export function ThemeToggle({ variant = "nav" }: { variant?: "nav" | "pill" }) {
  const preference = useSyncExternalStore(subscribe, readStored, (): Preference => "system");

  // While following the system setting, track changes to it live.
  useEffect(() => {
    if (preference !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);

  const label = `Theme: ${LABEL[preference]}`;
  if (variant === "pill") {
    return (
      <button type="button" className="pill" onClick={() => save(NEXT[preference])} aria-label={`${label}. Change theme`}>
        {label}
      </button>
    );
  }
  return (
    <button type="button" className="nav-btn as-button" onClick={() => save(NEXT[preference])} aria-label={`${label}. Change theme`}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
      {label}
    </button>
  );
}
