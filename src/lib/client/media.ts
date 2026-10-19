import { useSyncExternalStore } from "react";

/**
 * Whether a media query matches, kept up to date. Used to render ONE of two layouts (a table or a list of cards) instead of
 * both with CSS hiding one: a page of thousands of customers built every row twice. The server (and the first paint) assume
 * "no match", the table, so there is nothing to disagree with during hydration.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The width at and below which the customer list becomes cards. Matches the CSS breakpoint in app.css. */
export const PHONE_QUERY = "(max-width: 640px)";
