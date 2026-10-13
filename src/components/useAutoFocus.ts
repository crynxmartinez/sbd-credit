"use client";

import { useEffect, useRef } from "react";

/**
 * Moves focus to the first [data-autofocus] field when a form appears, so keyboard and screen-reader users land in it,
 * and hands focus back when the form goes away: to the control that opened it, or, if that control is gone (an approval
 * removes the Approve button), to the dialog it sits in. Focus is never left on the page body.
 */
export function useAutoFocus<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  // Remembered once per form. React may run this effect twice on mount in development; by the second run focus has
  // already moved into the form, so the opener must not be read again.
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);

  useEffect(() => {
    const node = ref.current;
    if (openerRef.current === undefined) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    const opener = openerRef.current;
    const dialog = node?.closest<HTMLElement>('[role="dialog"]') ?? null;
    node?.querySelector<HTMLElement>("[data-autofocus]")?.focus();

    return () => {
      const focusLost = !document.activeElement || document.activeElement === document.body;
      if (!focusLost) return;
      if (opener?.isConnected && opener !== document.body) opener.focus();
      else dialog?.focus();
    };
  }, []);

  return ref;
}
