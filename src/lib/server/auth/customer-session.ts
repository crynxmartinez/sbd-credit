import "server-only";
import { cache } from "react";
import { ApiError } from "../http";
import { prisma } from "../db";
import { log } from "../log";
import { clearSessionCookie, readSessionPayload, setSessionCookie } from "./session-cookies";

/** A signed-in customer contact. `customerId` is read from the database on every request, never from the cookie. */
export interface PortalUser {
  id: string;
  name: string;
  email: string;
  customerId: string;
}

export async function startCustomerSession(user: { id: string; sessionVersion: number }): Promise<void> {
  await setSessionCookie("customer", user);
}

/**
 * The signed-in customer contact, or null. Anything wrong with the account ends the session at once.
 *
 * Whether the customer's own account is approved, suspended or later reopened does NOT decide this: a person who still
 * owes money must still be able to see it. What they see for each standing is decided in domain/portal.ts.
 */
async function readCurrentCustomerUser(): Promise<PortalUser | null> {
  const payload = await readSessionPayload("customer");
  if (!payload) return null;

  const user = await prisma.customerUser.findUnique({
    where: { id: payload.u },
    select: { id: true, name: true, email: true, customerId: true, active: true, passwordHash: true, sessionVersion: true },
  });
  // A bumped session version, a disabled account or one that never finished setting a password is not signed in.
  if (!user || !user.active || user.passwordHash === null || user.sessionVersion !== payload.v) return null;
  return { id: user.id, name: user.name, email: user.email, customerId: user.customerId };
}

/** One lookup per request, however many layouts and pages ask (they all render within the same request). */
export const getCurrentCustomerUser = cache(readCurrentCustomerUser);

/** Signs a customer out everywhere. Like the staff sign-out, it removes the cookie only after the session was revoked. */
export async function endCustomerSession(): Promise<void> {
  const payload = await readSessionPayload("customer");
  if (payload) {
    try {
      await prisma.customerUser.updateMany({ where: { id: payload.u, sessionVersion: payload.v }, data: { sessionVersion: { increment: 1 } } });
    } catch (error) {
      log("error", "auth.customer_logout_revoke_failed", { userId: payload.u, error });
      throw new ApiError(503, "signout_failed", "Couldn't sign you out. Please try again.");
    }
  }
  await clearSessionCookie("customer");
}
