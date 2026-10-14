/**
 * Updates the address bar's query string in place. This is the browser's own history API, which Next's router
 * notices (useSearchParams updates), so filters and the open customer stay shareable without asking the server to
 * re-render the page on every keystroke or click.
 *
 * A value of null (or an empty string) removes the key. The current path and every other key are kept.
 */
function nextUrl(updates: Readonly<Record<string, string | null>>): string {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}`;
}

const isCurrent = (next: string): boolean => next === `${window.location.pathname}${window.location.search}`;

/** Marks a history entry as one we pushed to open a panel, so closing it can go Back instead of stacking another entry. */
const PANEL_FLAG = "creditPanel";

/**
 * The state to hand to pushState / replaceState. It must NOT be Next's own state object (the one carrying `__NA`): Next treats
 * a call that already has it as its own and does not tell the router, so useSearchParams would never update and the drawer
 * would never open. Next adds its bookkeeping to a plain object itself.
 */
const panelState = (open: boolean): { [PANEL_FLAG]: true } | null => (open ? { [PANEL_FLAG]: true } : null);
const isPanelEntry = (): boolean => (window.history.state as Record<string, unknown> | null)?.[PANEL_FLAG] === true;

export function replaceUrlParams(updates: Readonly<Record<string, string | null>>): void {
  const next = nextUrl(updates);
  if (!isCurrent(next)) window.history.replaceState(panelState(isPanelEntry()), "", next);
}

/** Opens something (the customer drawer) as a NEW history entry, so the browser's Back button closes it. */
export function pushUrlParams(updates: Readonly<Record<string, string | null>>): void {
  const next = nextUrl(updates);
  if (!isCurrent(next)) window.history.pushState(panelState(true), "", next);
}

/**
 * Closes what pushUrlParams opened. If this panel was opened by a push, Back removes that entry (so Forward does not
 * reopen it and the history stays tidy); if the page was loaded with the panel already open there is nothing to go back
 * to, so the address is simply rewritten.
 */
export function closeUrlPanel(updates: Readonly<Record<string, string | null>>): void {
  if (isPanelEntry()) window.history.back();
  else replaceUrlParams(updates);
}
