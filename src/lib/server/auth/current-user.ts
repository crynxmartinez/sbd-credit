import "server-only";
import { cookies } from "next/headers";
import { can, isRole, type Action } from "@/lib/domain/roles";
import type { SessionUser } from "@/lib/types";
import { ApiError } from "../http";
import { prisma } from "../db";
import { log } from "../log";
import { SESSION_TTL_MS, signSession, verifySession } from "./token";

const COOKIE_NAME = "credit_session";

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is not set. Add it to .env.local (see .env.example).");
  return value;
}

export async function startSession(user: { id: string; sessionVersion: number }): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, signSession(user, secret(), Date.now()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

/**
 * Signs out. Deleting the cookie only forgets the token in this browser; a copied token would still work for its full
 * lifetime. Bumping sessionVersion makes every outstanding token for this user fail the check in userFromCookie.
 */
export async function endSession(): Promise<{ revoked: boolean }> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  const payload = token ? verifySession(token, secret(), Date.now()) : null;

  // First, so this browser is signed out whatever happens to the database next.
  store.delete(COOKIE_NAME);
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
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;
  const payload = verifySession(token, secret(), Date.now());
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
