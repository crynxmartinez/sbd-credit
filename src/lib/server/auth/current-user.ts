import "server-only";
import { can, isRole, type Action } from "@/lib/domain/roles";
import type { SessionUser } from "@/lib/types";
import { ApiError } from "../http";
import { prisma } from "../db";
import { log } from "../log";
import { clearSessionCookie, readSessionPayload, setSessionCookie } from "./session-cookies";

export async function startSession(user: { id: string; sessionVersion: number }): Promise<void> {
  await setSessionCookie("staff", user);
}

/**
 * Signs out. Deleting the cookie only forgets the token in this browser; a copied token would still work for its full
 * lifetime. Bumping sessionVersion makes every outstanding token for this user fail the check in userFromCookie.
 */
export async function endSession(): Promise<{ revoked: boolean }> {
  const payload = await readSessionPayload("staff");

  // First, so this browser is signed out whatever happens to the database next.
  await clearSessionCookie("staff");
  if (!payload) return { revoked: true };

  try {
    await prisma.appUser.updateMany({
      where: { id: payload.u, sessionVersion: payload.v },
      data: { sessionVersion: { increment: 1 } },
    });
    return { revoked: true };
  } catch (error) {
    // The cookie is gone here, but a copy of the token elsewhere stays valid until it expires. Say so in the log.
    log("error", "auth.logout_revoke_failed", { userId: payload.u, error });
    return { revoked: false };
  }
}

function toSessionUser(user: { id: string; username: string; name: string; role: string }): SessionUser | null {
  return isRole(user.role) ? { id: user.id, username: user.username, name: user.name, role: user.role } : null;
}

async function userFromCookie(): Promise<SessionUser | null> {
  const payload = await readSessionPayload("staff");
  if (!payload) return null;

  const user = await prisma.appUser.findUnique({ where: { id: payload.u } });
  // A bumped sessionVersion or a deactivated account ends the session immediately.
  if (!user || !user.active || user.sessionVersion !== payload.v) return null;
  return toSessionUser(user);
}

/** Development only: skip the login screen by acting as the seeded dev admin. Never runs in a production build. */
async function devAutoLogin(): Promise<SessionUser | null> {
  if (process.env.NODE_ENV !== "development" || process.env.CREDIT_DEV_AUTOLOGIN !== "1") return null;
  const username = process.env.DEV_ADMIN_USERNAME;
  if (!username) return null;
  const user = await prisma.appUser.findUnique({ where: { username } });
  return user && user.active ? toSessionUser(user) : null;
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  return (await userFromCookie()) ?? (await devAutoLogin());
}

/** For route handlers: the signed-in user, or a 401. Pass an action to also require permission for it. */
export async function requireUser(action?: Action): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new ApiError(401, "unauthenticated", "Please sign in.");
  if (action && !can(user.role, action)) {
    throw new ApiError(403, "forbidden", "Your role does not allow that.");
  }
  return user;
}
