"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

type ToastKind = "ok" | "err";
interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

const OK_MS = 3_500;
const ERROR_MS = 6_500;

type Notify = (message: string, kind?: ToastKind) => void;
const ToastContext = createContext<Notify>(() => undefined);

export function useToast(): Notify {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const nextId = useRef(0);

  const notify = useCallback<Notify>((message, kind = "ok") => {
    nextId.current += 1;
    const id = nextId.current;
    setToasts((current) => [...current, { id, message, kind }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), kind === "err" ? ERROR_MS : OK_MS);
  }, []);

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Always mounted so screen readers announce new toasts as they arrive. */}
      <div className="toast-wrap" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast${toast.kind === "err" ? " err" : ""}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
