import "server-only";
import bcrypt from "bcryptjs";
import type { AppUser } from "@/generated/prisma/client";
import { isRole } from "@/lib/domain/roles";
import { ApiError } from "../http";
import { prisma } from "../db";
import { afterSuccess, isLocked, lockExpired, lockedUntilFor } from "./lockout";

const BCRYPT_COST = 12;

let dummyHash: Promise<string> | undefined;

/** A real hash to compare against when the username does not exist, so a miss takes as long as a wrong password. */
function missingUserHash(): Promise<string> {
  dummyHash ??= bcrypt.hash("no-such-user-placeholder", BCRYPT_COST);
  return dummyHash;
}

// One message for every way a sign-in can fail (wrong password, unknown user, deactivated or locked account), so the
// response never reveals which usernames exist.
const badLogin = () => new ApiError(401, "bad_login", "Incorrect username or password, or too many recent attempts.");

/**
 * Counts a wrong password. The increment happens in the database in one step, so a burst of parallel guesses cannot
 * all read "0 failures" and slip past the limit.
 */
async function recordFailure(user: Pick<AppUser, "id" | "failedLogins" | "lockedUntil">, now: Date): Promise<void> {
  if (lockExpired(user, now)) {
    await prisma.appUser.update({ where: { id: user.id }, data: { failedLogins: 1, lockedUntil: null } });
    return;
  }
  const { failedLogins } = await prisma.appUser.update({
    where: { id: user.id },
    data: { failedLogins: { increment: 1 } },
    select: { failedLogins: true },
  });
  const until = lockedUntilFor(failedLogins, now);
  if (until) await prisma.appUser.update({ where: { id: user.id }, data: { lockedUntil: until } });
}

/** Checks a username and password. Returns the user, or throws the one generic failure. */
export async function authenticate(username: string, password: string, now: Date = new Date()): Promise<AppUser> {
  const user = await prisma.appUser.findUnique({ where: { username: username.toLowerCase() } });

  // Always hash-compare, even for a locked or unknown account, so timing says nothing about which case it was.
  const matches = await bcrypt.compare(password, user?.passwordHash ?? (await missingUserHash()));
  const locked = user ? isLocked(user, now) : false;

  if (!user || !user.active || locked || !matches) {
    if (user && user.active && !locked && !matches) await recordFailure(user, now);
    throw badLogin();
  }
  if (!isRole(user.role)) throw badLogin();

  await prisma.appUser.update({ where: { id: user.id }, data: afterSuccess() });
  return user;
}
