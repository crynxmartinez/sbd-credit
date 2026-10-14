import "server-only";
import { endCustomerSession } from "./customer-session";
import { endSession } from "./current-user";

/**
 * Ends every kind of session this browser holds, so one sign-out leaves nothing behind. Both are always attempted; if
 * either could not be revoked the sign-out reports failure (the other kind is already ended).
 */
export async function endAllSessions(): Promise<void> {
  const results = await Promise.allSettled([endSession(), endCustomerSession()]);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}
