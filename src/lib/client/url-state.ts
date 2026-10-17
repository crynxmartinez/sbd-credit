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

const currentUrl = (): string => `${window.location.pathname}${window.location.search}`;
const isCurrent = (next: string): boolean => next === currentUrl();

/** Marks a history entry as one we pushed to open a panel, so closing it can go Back instead of stacking another entry. */
const PANEL_FLAG = "creditPanel";
/**
 * Marks a history entry we pushed ON TOP of the current address while there is unsaved work (see back-guard.ts). The browser's
 * Back button then removes only this entry: the address does not change, so nothing on screen is unmounted, and there is
 * time to ask before really leaving.
 */
const GUARD_FLAG = "creditGuard";
/** On a guard entry: whether the entry beneath it is a panel entry (so closing the panel has to go back past both). */
const BELOW_PANEL_FLAG = "creditBelowPanel";

type HistoryFlags = Record<string, unknown> | null;
const flagsOf = (): HistoryFlags => window.history.state as HistoryFlags;

/**
 * The state to hand to pushState / replaceState. It must NOT be Next's own state object (the one carrying `__NA`): Next treats
 * a call that already has it as its own and does not tell the router, so useSearchParams would never update and the drawer
 * would never open. Next adds its bookkeeping to a plain object itself.
 */
const panelState = (open: boolean): { [PANEL_FLAG]: true } | null => (open ? { [PANEL_FLAG]: true } : null);
const isPanelEntry = (): boolean => flagsOf()?.[PANEL_FLAG] === true;

/** True when the entry the browser is on is a guard entry. */
export function isGuardEntry(): boolean {
  return flagsOf()?.[GUARD_FLAG] === true;
}

let skipBackGuard = false;

/** True once, right after our own code went Back on purpose: the Back button guard must not treat it as the person's Back. */
export function consumeBackGuardSkip(): boolean {
  const skip = skipBackGuard;
  skipBackGuard = false;
  return skip;
}

/** Our own code is about to move through history: the next popstate is ours, not the person's. */
function expectOwnNavigation(): void {
  skipBackGuard = true;
  // If no popstate follows (nothing moved), forget it, or a real Back button press later would slip past the guard.
  window.setTimeout(() => {
    skipBackGuard = false;
  }, 1_000);
}

/** Pushes a guard entry at the current address. */
export function pushGuardEntry(): void {
  window.history.pushState({ [GUARD_FLAG]: true, [BELOW_PANEL_FLAG]: isPanelEntry() }, "", currentUrl());
}

/** Removes the guard entry, if the browser is on it. */
export function popGuardEntry(): void {
  if (!isGuardEntry()) return;
  expectOwnNavigation();
  window.history.back();
}

/** Goes Back one real step (the guard entry is already gone). Used once the person confirmed leaving. */
export function goBackForReal(): void {
  expectOwnNavigation();
  window.history.back();
}

export function replaceUrlParams(updates: Readonly<Record<string, string | null>>): void {
  const next = nextUrl(updates);
  if (isCurrent(next)) return;
  // Keep whatever kind of entry this is: a panel entry stays one, a guard entry stays one.
  const state = isGuardEntry() ? { [GUARD_FLAG]: true, [BELOW_PANEL_FLAG]: flagsOf()?.[BELOW_PANEL_FLAG] === true } : panelState(isPanelEntry());
  window.history.replaceState(state, "", next);
}

/** Opens something (the customer drawer) as a NEW history entry, so the browser's Back button closes it. */
export function pushUrlParams(updates: Readonly<Record<string, string | null>>): void {
  const next = nextUrl(updates);
  if (isCurrent(next)) return;
  // On a guard entry (a form that is closing right now) swap it for the new entry instead of stacking one above it.
  if (isGuardEntry()) window.history.replaceState(panelState(true), "", next);
  else window.history.pushState(panelState(true), "", next);
}

/**
 * Closes what pushUrlParams opened. If this panel was opened by a push, Back removes that entry (so Forward does not
 * reopen it and the history stays tidy); if the page was loaded with the panel already open there is nothing to go back
 * to, so the address is simply rewritten. A guard entry on top of the panel goes first.
 */
export function closeUrlPanel(updates: Readonly<Record<string, string | null>>): void {
  if (isGuardEntry()) {
    if (flagsOf()?.[BELOW_PANEL_FLAG] === true) {
      expectOwnNavigation();
      window.history.go(-2);
    } else {
      // The panel was not opened by a push (a shared link): rewrite this entry's address, there is no history to go back through.
      // The guard flag is dropped on purpose: left on, the guard's own clean-up would "pop" this entry and land back on the
      // address that opened the panel, reopening it.
      window.history.replaceState(null, "", nextUrl(updates));
    }
    return;
  }
  if (isPanelEntry()) {
    expectOwnNavigation();
    window.history.back();
  } else replaceUrlParams(updates);
}
