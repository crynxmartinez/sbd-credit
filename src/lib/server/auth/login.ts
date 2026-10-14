import "server-only";
import bcrypt from "bcryptjs";
import type { AppUser, CustomerUser } from "@/generated/prisma/client";
import { isRole } from "@/lib/domain/roles";
import { BCRYPT_COST, normalizeIdentifier } from "@/lib/domain/users";
import { ApiError } from "../http";
import { prisma } from "../db";
import { log } from "../log";
import { LOCKOUT_MS, MAX_FAILED_LOGINS, afterSuccess, isLocked, shouldAlertOnCustomerFailures } from "./lockout";

let dummyHash: Promise<string> | undefined;

/** A real hash to compare against when there is nobody to check, so a miss takes as long as a wrong password. */
function missingUserHash(): Promise<string> {
  dummyHash ??= bcrypt.hash("no-such-user-placeholder", BCRYPT_COST);
  return dummyHash;
}

// One message for every way a sign-in can fail (wrong password, unknown name, disabled, locked, not yet invited, or a name
// that matches more than one account), so the response never reveals which names exist or which kind of account it is.
const badLogin = () => new ApiError(401, "bad_login", "Incorrect username or password, or too many recent attempts.");

export type Authenticated = { kind: "staff"; user: AppUser } | { kind: "customer"; user: CustomerUser };

/**
 * Counts a wrong password and locks the account at the limit, all in ONE statement. Reading the count, deciding, then
 * writing would let a burst of parallel guesses all see the old count and slip past the limit (or, just after a lock
 * expires, all restart the count at 1 and never re-lock).
 */
async function recordStaffFailure(user: Pick<AppUser, "id">, now: Date): Promise<void> {
  const until = new Date(now.getTime() + LOCKOUT_MS);
  await prisma.$executeRaw`
    UPDATE "AppUser" SET
      "failedLogins" = CASE WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${now} THEN 1 ELSE "failedLogins" + 1 END,
      "lockedUntil" = CASE
        WHEN (CASE WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${now} THEN 1 ELSE "failedLogins" + 1 END) >= ${MAX_FAILED_LOGINS} THEN ${until}
        WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${now} THEN NULL
        ELSE "lockedUntil" END
    WHERE "id" = ${user.id}`;
}

/**
 * Counts a wrong password for a customer. There is deliberately NO lock: anyone who knows a customer's email could use it
 * to lock them out. See lockout.ts for what protects them instead. A long run of failures is logged.
 */
async function recordCustomerFailure(user: Pick<CustomerUser, "id">): Promise<void> {
  const { failedLogins } = await prisma.customerUser.update({
    where: { id: user.id },
    data: { failedLogins: { increment: 1 } },
    select: { failedLogins: true },
  });
  if (shouldAlertOnCustomerFailures(failedLogins)) log("warn", "portal.many_failed_logins", { customerUserId: user.id, failedLogins });
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

  const matches = await bcrypt.compare(password, candidate?.user.passwordHash ?? (await missingUserHash()));
  const usable = candidate !== null && eligible(candidate);
  const locked = candidate ? isLocked(candidate.user, now) : false;

  if (!candidate || !usable || locked || !matches) {
    if (candidate && usable && !locked && !matches) {
      await (candidate.kind === "staff" ? recordStaffFailure(candidate.user, now) : recordCustomerFailure(candidate.user));
    }
    throw badLogin();
  }

  if (candidate.kind === "staff") {
    await prisma.appUser.update({ where: { id: candidate.user.id }, data: afterSuccess() });
  } else {
    await prisma.customerUser.update({ where: { id: candidate.user.id }, data: { ...afterSuccess(), lastLoginAt: now } });
  }
  return candidate;
}
