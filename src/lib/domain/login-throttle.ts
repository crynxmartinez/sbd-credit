/**
 * How sign-in guessing is slowed down, WITHOUT letting a stranger lock a real person out.
 *
 * The old rule locked a staff account for everybody after five wrong passwords. A staff username is not a secret, so anyone
 * could keep a chosen person out simply by typing wrong passwords. The rule here counts failures per (address, name) pair
 * instead, and answers with a wait that doubles. An attacker slows only HIMSELF: the real person, signing in from their own
 * address, has their own empty count. It costs a guesser one request every few minutes at best, which is what stops a run
 * of guesses, and it applies the same way to names that exist and names that do not, so it reveals nothing.
 *
 * Pure: no database, no clock of its own (the clock is passed in). The state lives in memory, per running server, like the
 * other sign-in limits; see docs/PRODUCTION.md.
 */

/** Wrong passwords per (address, name) that cost nothing extra. People mistype. */
export const FREE_FAILURES = 3;
const FIRST_COOLDOWN_MS = 2_000;
/** The longest wait. Beyond this the wait stops growing: 15 minutes is already one guess per quarter hour. */
export const COOLDOWN_CAP_MS = 15 * 60_000;
const FORGET_AFTER_MS = 15 * 60_000;
const DEFAULT_MAX_KEYS = 10_000;

/** The wait imposed after this many failures in a row. Zero while within the free count. */
export function cooldownAfter(failures: number, freeFailures: number = FREE_FAILURES): number {
  if (failures <= freeFailures) return 0;
  const doublings = failures - freeFailures - 1;
  // Past 30 doublings the number is far above the cap anyway; stopping there keeps the arithmetic exact.
  return Math.min(FIRST_COOLDOWN_MS * 2 ** Math.min(doublings, 30), COOLDOWN_CAP_MS);
}

interface KeyState {
  failures: number;
  lastFailureAt: number;
  blockedUntil: number;
}

export interface LoginThrottle {
  /** Whether this key may try now, and if not how long until it may. Never counts as a failure. */
  check(key: string): { allowed: true } | { allowed: false; retryAfterMs: number };
  /** Records a wrong password (or any failed sign-in) for the key. */
  fail(key: string): void;
  /** Forgets the key: a right password. */
  succeed(key: string): void;
  size(): number;
}

interface Options {
  now?: () => number;
  freeFailures?: number;
  forgetAfterMs?: number;
  /** Most keys remembered at once, so a flood of distinct addresses cannot grow memory without bound. */
  maxKeys?: number;
}

export function createLoginThrottle({ now = Date.now, freeFailures = FREE_FAILURES, forgetAfterMs = FORGET_AFTER_MS, maxKeys = DEFAULT_MAX_KEYS }: Options = {}): LoginThrottle {
  const states = new Map<string, KeyState>();

  const stale = (state: KeyState, at: number) => at >= Math.max(state.blockedUntil, state.lastFailureAt) + forgetAfterMs;

  function live(key: string, at: number): KeyState | undefined {
    const state = states.get(key);
    if (!state) return undefined;
    if (stale(state, at)) {
      states.delete(key);
      return undefined;
    }
    return state;
  }

  function makeRoom(at: number): void {
    if (states.size < maxKeys) return;
    for (const [key, state] of states) if (stale(state, at)) states.delete(key);
    if (states.size >= maxKeys) {
      const oldest = states.keys().next().value;
      if (oldest !== undefined) states.delete(oldest);
    }
  }

  return {
    check(key) {
      const at = now();
      const state = live(key, at);
      if (!state || state.blockedUntil <= at) return { allowed: true };
      return { allowed: false, retryAfterMs: state.blockedUntil - at };
    },
    fail(key) {
      const at = now();
      const existing = live(key, at);
      if (!existing) makeRoom(at);
      const failures = (existing?.failures ?? 0) + 1;
      // Re-insert so the oldest-first order of the map follows the most recent failure.
      states.delete(key);
      states.set(key, { failures, lastFailureAt: at, blockedUntil: at + cooldownAfter(failures, freeFailures) });
    },
    succeed(key) {
      states.delete(key);
    },
    size: () => states.size,
  };
}
