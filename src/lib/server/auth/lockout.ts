/** Failed sign-ins before an account is temporarily locked, and for how long. */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

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
export function lockedUntilFor(failedLogins: number, now: Date): Date | null {
  return failedLogins >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCKOUT_MS) : null;
}

/** State after a wrong password. Locks the account once the limit is reached. */
export function afterFailure(state: LoginState, now: Date): LoginState {
  const failedLogins = (lockExpired(state, now) ? 0 : state.failedLogins) + 1;
  return { failedLogins, lockedUntil: lockedUntilFor(failedLogins, now) };
}

export function afterSuccess(): LoginState {
  return { failedLogins: 0, lockedUntil: null };
}
