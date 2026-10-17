/**
 * Nobody is locked out by wrong passwords, staff and customers alike. A sign-in name is not a secret (a customer's is their
 * email; a staff username is easy to learn), so ANY count that locks an account lets a stranger shut a real person out on
 * purpose. What slows a guessing run instead is: the per-address limit and the per-(address, name) wait that doubles
 * (domain/login-throttle.ts, applied in the sign-in route), the cost of each password check, and the password rules.
 *
 * Failures are still counted on the account, and a long run of them is logged, so a person can look into it.
 */
export const ALERT_FAILURES = 10;
export const ALERT_WINDOW_MS = 15 * 60_000;
const DEFAULT_MAX_KEYS = 10_000;

export interface FailureWatch {
  /** Counts a wrong password for this account. True once per window, when the count first reaches the threshold. */
  record(key: string): boolean;
  /** A good sign-in: forget the account's failures. */
  clear(key: string): void;
  size(): number;
}

/**
 * Notices a guessing run against one account, however many addresses it comes from. The wait in the sign-in route is per
 * (address, name), so a run spread over many addresses is not slowed by it; what protects the account then is the password
 * rules and the cost of each check, and this makes sure a person HEARS about it (a warn-level log line) within minutes,
 * instead of after some distant total. Per running server, like the other sign-in counters.
 */
export function createFailureWatch({ now = Date.now, threshold = ALERT_FAILURES, windowMs = ALERT_WINDOW_MS, maxKeys = DEFAULT_MAX_KEYS }: { now?: () => number; threshold?: number; windowMs?: number; maxKeys?: number } = {}): FailureWatch {
  const failures = new Map<string, { times: number[]; alertedAt: number | null }>();
  return {
    record(key) {
      const at = now();
      const state = failures.get(key) ?? { times: [], alertedAt: null };
      const times = [...state.times.filter((time) => time > at - windowMs), at];
      const alerted = state.alertedAt !== null && state.alertedAt > at - windowMs;
      const raise = times.length >= threshold && !alerted;
      failures.delete(key);
      if (!failures.has(key) && failures.size >= maxKeys) {
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
      failures.set(key, { times, alertedAt: raise ? at : alerted ? state.alertedAt : null });
      return raise;
    },
    clear(key) {
      failures.delete(key);
    },
    size: () => failures.size,
  };
}

export interface LoginState {
  failedLogins: number;
  lockedUntil: Date | null;
}

/**
 * A lock that is already on the row, set by hand in the database or left over from the earlier rule (which locked staff for
 * 15 minutes). Nothing sets one any more, but one that exists is still honoured until it runs out.
 */
export function isLocked(state: LoginState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

export function afterSuccess(): LoginState {
  return { failedLogins: 0, lockedUntil: null };
}
