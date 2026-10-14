import { describe, expect, test } from "vitest";
import {
  CUSTOMER_FAILURE_ALERT_EVERY,
  LOCKOUT_MS,
  MAX_FAILED_LOGINS,
  afterFailure,
  afterSuccess,
  isLocked,
  lockExpired,
  lockedUntilFor,
  shouldAlertOnCustomerFailures,
} from "./lockout";

const NOW = new Date("2026-10-13T12:00:00Z");

describe("lockout", () => {
  test("counts failures without locking below the limit", () => {
    let state = afterSuccess();
    for (let i = 1; i < MAX_FAILED_LOGINS; i += 1) {
      state = afterFailure(state, NOW);
      expect(state.failedLogins).toBe(i);
      expect(isLocked(state, NOW)).toBe(false);
    }
  });

  test("locks on the failure that reaches the limit", () => {
    let state = afterSuccess();
    for (let i = 0; i < MAX_FAILED_LOGINS; i += 1) state = afterFailure(state, NOW);
    expect(isLocked(state, NOW)).toBe(true);
    expect(state.lockedUntil?.getTime()).toBe(NOW.getTime() + LOCKOUT_MS);
  });

  test("the lock lifts after the lockout period", () => {
    let state = afterSuccess();
    for (let i = 0; i < MAX_FAILED_LOGINS; i += 1) state = afterFailure(state, NOW);
    expect(isLocked(state, new Date(NOW.getTime() + LOCKOUT_MS + 1))).toBe(false);
  });

  test("an expired lock starts the count over", () => {
    const expired = { failedLogins: MAX_FAILED_LOGINS, lockedUntil: new Date(NOW.getTime() - 1) };
    expect(afterFailure(expired, NOW)).toEqual({ failedLogins: 1, lockedUntil: null });
  });

  test("lockedUntilFor locks only once the failure count reaches the limit", () => {
    expect(lockedUntilFor(MAX_FAILED_LOGINS - 1, NOW)).toBeNull();
    expect(lockedUntilFor(MAX_FAILED_LOGINS, NOW)?.getTime()).toBe(NOW.getTime() + LOCKOUT_MS);
    expect(lockedUntilFor(MAX_FAILED_LOGINS + 20, NOW)).not.toBeNull();
  });

  test("lockExpired is true only for a lock that has run out", () => {
    expect(lockExpired({ failedLogins: 5, lockedUntil: new Date(NOW.getTime() - 1) }, NOW)).toBe(true);
    expect(lockExpired({ failedLogins: 5, lockedUntil: new Date(NOW.getTime() + 1) }, NOW)).toBe(false);
    expect(lockExpired({ failedLogins: 2, lockedUntil: null }, NOW)).toBe(false);
  });

  test("success clears everything", () => {
    expect(afterSuccess()).toEqual({ failedLogins: 0, lockedUntil: null });
  });
});

describe("customer failures", () => {
  test("a customer is never locked by a count of wrong guesses: their email is easy to find, so a stranger could lock them out", () => {
    expect(lockedUntilFor(1_000_000, NOW, Number.POSITIVE_INFINITY)).toBeNull();
  });

  test("but a run of failures is raised, so someone notices: at every Nth failure", () => {
    expect(shouldAlertOnCustomerFailures(0)).toBe(false);
    expect(shouldAlertOnCustomerFailures(CUSTOMER_FAILURE_ALERT_EVERY - 1)).toBe(false);
    expect(shouldAlertOnCustomerFailures(CUSTOMER_FAILURE_ALERT_EVERY)).toBe(true);
    expect(shouldAlertOnCustomerFailures(CUSTOMER_FAILURE_ALERT_EVERY + 1)).toBe(false);
    expect(shouldAlertOnCustomerFailures(CUSTOMER_FAILURE_ALERT_EVERY * 3)).toBe(true);
  });
});
