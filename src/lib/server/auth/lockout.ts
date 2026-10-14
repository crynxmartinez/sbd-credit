/** Failed sign-ins before an account is temporarily locked, and for how long. */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
/**
 * Customers sign in with an email, which anyone who knows the customer can guess. ANY count that locks the account lets a
 * stranger lock a customer out on purpose, so a customer is never locked by failures. What stops a guessing run is the
 * per-address limit, the per-account-and-address limit in the sign-in route, the cost of each password check, and the
 * 12-character minimum. A long run of failures is logged instead, so a person can look into it.
 */
export const CUSTOMER_FAILURE_ALERT_EVERY = 30;

export function shouldAlertOnCustomerFailures(failedLogins: number): boolean {
  return failedLogins > 0 && failedLogins % CUSTOMER_FAILURE_ALERT_EVERY === 0;
}

export interface LoginState {
  failedLogins: number;
  lockedUntil: Date | null;
}

export function isLocked(state: LoginState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/** A lock that has run out. The next failure starts the count over instead of adding to the old one. */
export function lockExpired(state: LoginState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() <= now.getTime();
}

/** When to lock until, given the failure count AFTER an atomic increment. Null while under the limit. */
export function lockedUntilFor(failedLogins: number, now: Date, maxFailed: number = MAX_FAILED_LOGINS): Date | null {
  return failedLogins >= maxFailed ? new Date(now.getTime() + LOCKOUT_MS) : null;
}

/** State after a wrong password. Locks the account once the limit is reached. */
export function afterFailure(state: LoginState, now: Date): LoginState {
  const failedLogins = (lockExpired(state, now) ? 0 : state.failedLogins) + 1;
  return { failedLogins, lockedUntil: lockedUntilFor(failedLogins, now) };
}

export function afterSuccess(): LoginState {
  return { failedLogins: 0, lockedUntil: null };
}
