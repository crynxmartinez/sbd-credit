"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type ToastKind = "ok" | "err";
interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

/** A confirmation fades after this long. An error stays until it is dismissed: it is not safe to miss. */
const OK_MS = 6_000;

type Notify = (message: string, kind?: ToastKind) => void;
const ToastContext = createContext<Notify>(() => undefined);

export function useToast(): Notify {
  return useContext(ToastContext);
}

/**
 * While a dialog or drawer is open it is marked aria-modal, so a screen reader ignores everything outside it, including
 * the toast area at the bottom of the page. The message is therefore also written into a hidden live region INSIDE the
 * topmost dialog, which is the one place it will be heard.
 */
function announceInDialog(message: string): void {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
  const top = dialogs[dialogs.length - 1];
  if (!top) return;
  let region = top.querySelector<HTMLElement>(":scope > [data-toast-live]");
  if (!region) {
    region = document.createElement("div");
    region.setAttribute("data-toast-live", "");
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.className = "sr-only";
    top.appendChild(region);
  }
  // Emptied first, so the same message twice in a row is still announced.
  region.textContent = "";
  window.setTimeout(() => {
    if (region) region.textContent = message;
  }, 50);
}

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);

  // A confirmation fades by itself, but not while the pointer or keyboard focus is on it (WCAG 2.2.1).
  useEffect(() => {
    if (toast.kind === "err" || paused) return;
    const timer = window.setTimeout(() => onDismiss(toast.id), OK_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.kind, paused, onDismiss]);

  return (
    <div
      className={`toast${toast.kind === "err" ? " err" : ""}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span>{toast.message}</span>
      <button type="button" className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss message">
        ×
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);

  const notify = useCallback<Notify>((message, kind = "ok") => {
    nextId.current += 1;
    const id = nextId.current;
    setToasts((current) => [...current, { id, message, kind }]);
    announceInDialog(message);
  }, []);

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Always mounted so screen readers announce new toasts as they arrive. Errors are announced assertively. */}
      <div className="toast-stack">
      <div className="toast-wrap" role="status" aria-live="polite">
        {toasts
          .filter((toast) => toast.kind === "ok")
          .map((toast) => (
            <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
      </div>
      <div className="toast-wrap" role="alert">
        {toasts
          .filter((toast) => toast.kind === "err")
          .map((toast) => (
            <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
      </div>
      </div>
    </ToastContext.Provider>
  );
}
