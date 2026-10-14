"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Open dialogs, innermost last. Only the top one reacts to the keyboard, so a modal over a drawer owns Tab and Escape. */
const openDialogs: HTMLElement[] = [];

/**
 * Behaviour every dialog and drawer needs: focus moves in on open, Tab stays inside, Escape closes,
 * the page behind does not scroll, and focus returns to whatever opened it. Mark the field to focus first
 * with data-autofocus.
 *
 * The key handler lives on the document, not on the dialog. Controls inside a dialog come and go (a form closes, a
 * button disappears when its action completes), and when the focused element is removed the browser drops focus to
 * the page body, where a handler on the dialog would never hear the next Tab.
 */
export function useDialog(onClose: () => void): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
    (node.querySelector<HTMLElement>("[data-autofocus]") ?? items()[0] ?? node).focus();
    openDialogs.push(node);

    const onKeyDown = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== node) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = items();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && active !== node && node.contains(active);
      if (!inside) {
        // Focus fell out of the dialog (or is on its frame): bring it back in at the right end.
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // aria-modal alone is not honoured by every screen reader, so the page behind is also made inert: nothing in it can be
    // reached by keyboard, pointer or assistive technology while a dialog is open.
    const background = document.querySelector<HTMLElement>(".app");
    background?.setAttribute("inert", "");
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      openDialogs.splice(openDialogs.indexOf(node), 1);
      document.body.style.overflow = previousOverflow;
      if (openDialogs.length === 0) background?.removeAttribute("inert");
      opener?.focus();
    };
  }, []);

  return ref;
}
