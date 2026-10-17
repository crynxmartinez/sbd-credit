import { useEffect, useRef } from "react";
import { consumeBackGuardSkip, goBackForReal, isGuardEntry, popGuardEntry, pushGuardEntry } from "./url-state";

/**
 * Asks before the browser's Back button throws away unsaved work.
 *
 * Close and Escape already ask. Back does not go through them: the browser moves first, and the router (which listens for
 * that move before any of our code can) unmounts the screen, typing and all. So while there IS unsaved work we add a "guard"
 * entry to the history, at the same address. Back then removes only that entry: the address does not change, nothing is
 * unmounted, and we can ask:
 *   - Cancel: the guard entry is put back. Nothing happened.
 *   - OK: every screen that was holding work is told to let go (`onLeave`), and we go Back for real, which the router
 *     handles as usual (closing the customer, leaving the page).
 * When the work is saved or discarded some other way, the guard entry is removed quietly.
 *
 * One entry serves every guard, so a form open over a customer asks ONCE, not twice.
 */
interface Guard {
  active: () => boolean;
  message: () => string | null;
  onLeave: () => void;
}

const guards = new Map<symbol, Guard>();
let listening = false;
/** Whether we have a guard entry on the history stack right now. */
let entryPushed = false;

function activeGuards(): Guard[] {
  return [...guards.values()].filter((guard) => guard.active());
}

/** Adds or removes the guard entry so it exists exactly while some screen holds unsaved work. */
function sync(): void {
  const anyActive = activeGuards().length > 0;
  if (anyActive && !entryPushed) {
    pushGuardEntry();
    entryPushed = true;
  } else if (!anyActive && entryPushed) {
    entryPushed = false;
    popGuardEntry();
  }
}

function onPopState(): void {
  // Our own code moved through history (closing a panel, removing the guard entry): not the person's Back button.
  if (consumeBackGuardSkip()) return;
  // Only a move that took us OFF the guard entry is the person pressing Back.
  if (!entryPushed || isGuardEntry()) return;

  const holding = activeGuards();
  const message = holding.map((guard) => guard.message()).find((text): text is string => Boolean(text));
  if (!holding.length || !message) {
    entryPushed = false;
    return;
  }
  if (!window.confirm(message)) {
    pushGuardEntry();
    return;
  }
  entryPushed = false;
  for (const guard of holding) guard.onLeave();
  goBackForReal();
}

function ensureListening(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("popstate", onPopState);
}

interface Options {
  /** Whether there is unsaved work right now. */
  active: boolean;
  /** What to ask. */
  message: () => string | null;
  /**
   * Called when the person confirmed they are leaving, for a screen that Back will NOT close by itself (a form open on the
   * page). A screen that is a history entry of its own (the customer drawer) needs nothing: going Back closes it.
   */
  onLeave?: () => void;
}

export function useBackGuard({ active, message, onLeave }: Options): void {
  const latest = useRef({ active, message, onLeave });
  useEffect(() => {
    latest.current = { active, message, onLeave };
  });

  useEffect(() => {
    ensureListening();
    const key = Symbol("back-guard");
    guards.set(key, {
      active: () => latest.current.active,
      message: () => latest.current.message(),
      onLeave: () => latest.current.onLeave?.(),
    });
    return () => {
      guards.delete(key);
      sync();
    };
  }, []);

  // Runs after the effect above has stored the latest values, so `sync` sees the current `active`.
  useEffect(() => {
    sync();
  }, [active]);
}
