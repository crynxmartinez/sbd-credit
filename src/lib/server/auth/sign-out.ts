import "server-only";
import { endCustomerSession } from "./customer-session";
import { endSession } from "./current-user";

/** Ends every kind of session this browser holds, so one sign-out leaves nothing behind. */
export async function endAllSessions(): Promise<{ revoked: boolean }> {
  const [staff, customer] = await Promise.all([endSession(), endCustomerSession()]);
  return { revoked: staff.revoked && customer.revoked };
}
