import "server-only";
import bcrypt from "bcryptjs";
import type { AppUser, CustomerUser } from "@/generated/prisma/client";
import { isRole } from "@/lib/domain/roles";
import { BCRYPT_COST, normalizeIdentifier } from "@/lib/domain/users";
import { ApiError } from "../http";
import { prisma } from "../db";
import { log } from "../log";
import { createHashSlots, HashQueueFull } from "./hash-slots";
import { afterSuccess, createFailureWatch, isLocked } from "./lockout";

/** Notices a run of wrong passwords against one account, from however many addresses. */
const failureWatch = createFailureWatch();

/** At most this many password checks at once, and a few waiting. See hash-slots.ts for why. */
const hashSlots = createHashSlots({ slots: 4, maxQueue: 24 });

let dummyHash: Promise<string> | undefined;

/** Computes the placeholder hash now (at startup) instead of on the first unknown-name sign-in. */
export async function prepareLoginTiming(): Promise<void> {
  await missingUserHash();
}

/** A real hash to compare against when there is nobody to check, so a miss takes as long as a wrong password. */
function missingUserHash(): Promise<string> {
  dummyHash ??= bcrypt.hash("no-such-user-placeholder", BCRYPT_COST);
  return dummyHash;
}

export type LoginFailureReason = "unknown" | "ambiguous" | "inactive" | "not_invited" | "locked" | "bad_password";

/**
 * ONE message for every way a sign-in can fail (wrong password, unknown name, disabled, locked, not yet invited, or a name
 * that matches more than one account), so the response never reveals which names exist or which kind of account it is.
 * The real reason travels on the error so the server can LOG it; it is never sent to the browser.
 */
export class LoginFailure extends ApiError {
  constructor(
    readonly reason: LoginFailureReason,
    readonly kind: "staff" | "customer" | null,
    readonly userId: string | null,
  ) {
    super(401, "bad_login", "Incorrect username or password, or too many recent attempts.");
  }
}

export type Authenticated = { kind: "staff"; user: AppUser } | { kind: "customer"; user: CustomerUser };

/**
 * Counts a wrong password on the account, in ONE atomic statement (a burst of parallel guesses must each be counted), and
 * logs a long run of failures. There is deliberately NO lock, for staff or customers: a sign-in name is easy to learn, so a
 * lock would let a stranger shut a real person out. What slows a guesser is the per-(address, name) wait in the sign-in
 * route; see lockout.ts.
 */
async function recordFailure(candidate: Authenticated): Promise<void> {
  const [row] =
    candidate.kind === "staff"
      ? await prisma.$queryRaw<{ failedLogins: number }[]>`UPDATE "AppUser" SET "failedLogins" = "failedLogins" + 1 WHERE "id" = ${candidate.user.id} RETURNING "failedLogins"`
      : await prisma.$queryRaw<{ failedLogins: number }[]>`UPDATE "CustomerUser" SET "failedLogins" = "failedLogins" + 1 WHERE "id" = ${candidate.user.id} RETURNING "failedLogins"`;
  if (row && failureWatch.record(candidate.user.id)) {
    log("warn", "auth.many_failed_logins", { kind: candidate.kind, userId: candidate.user.id, failedLogins: row.failedLogins });
  }
}

/** One password check, through the cap on how many run at once. A flood is refused instead of stalling every other request. */
async function comparePassword(password: string, hash: string): Promise<boolean> {
  try {
    return await hashSlots.run(() => bcrypt.compare(password, hash));
  } catch (error) {
    if (error instanceof HashQueueFull) {
      throw new ApiError(503, "busy", "Too many people are signing in right now. Please wait a moment and try again.");
    }
    throw error;
  }
}

function failureReason(input: { candidate: Authenticated | null; staff: unknown; customer: unknown; usable: boolean; locked: boolean }): LoginFailureReason {
  const { candidate } = input;
  if (!candidate) return input.staff && input.customer ? "ambiguous" : "unknown";
  if (!input.usable) return candidate.kind === "customer" && candidate.user.active && candidate.user.passwordHash === null ? "not_invited" : "inactive";
  return input.locked ? "locked" : "bad_password";
}

function eligible(candidate: Authenticated): boolean {
  if (candidate.kind === "staff") return candidate.user.active && isRole(candidate.user.role);
  return candidate.user.active && candidate.user.passwordHash !== null;
}

/**
 * Checks a username-or-email and a password for either kind of person. Returns who they are, or throws the one generic
 * failure.
 *
 * Every attempt looks up both tables and compares exactly one password hash, so the response says nothing about
 * whether a name exists, which kind it is, or why it failed, and the (large) hashing time is the same in every case.
 * The only extra work is counting a wrong password for a real, usable account: a few milliseconds beside the hash, and
 * sampling it is capped by the per-address limits in the sign-in route. A name
 * that matches BOTH kinds is refused outright and counts against neither account.
 */
export async function authenticateAny(identifier: string, password: string, now: Date = new Date()): Promise<Authenticated> {
  const id = normalizeIdentifier(identifier);
  const [staff, customer] = await Promise.all([
    prisma.appUser.findUnique({ where: { username: id } }),
    prisma.customerUser.findUnique({ where: { email: id } }),
  ]);

  let candidate: Authenticated | null = null;
  if (staff && !customer) candidate = { kind: "staff", user: staff };
  else if (customer && !staff) candidate = { kind: "customer", user: customer };

  const matches = await comparePassword(password, candidate?.user.passwordHash ?? (await missingUserHash()));
  const usable = candidate !== null && eligible(candidate);
  const locked = candidate ? isLocked(candidate.user, now) : false;

  if (!candidate || !usable || locked || !matches) {
    if (candidate && usable && !locked && !matches) {
      await recordFailure(candidate);
    }
    throw new LoginFailure(failureReason({ candidate, staff, customer, usable, locked }), candidate?.kind ?? null, candidate?.user.id ?? null);
  }

  failureWatch.clear(candidate.user.id);
  if (candidate.kind === "staff") {
    await prisma.appUser.update({ where: { id: candidate.user.id }, data: afterSuccess() });
  } else {
    await prisma.customerUser.update({ where: { id: candidate.user.id }, data: { ...afterSuccess(), lastLoginAt: now } });
  }
  return candidate;
}
