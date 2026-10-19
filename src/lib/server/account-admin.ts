import { userInfo } from "node:os";
import type { PrismaClient } from "@/generated/prisma/client";
import { SESSION_EPOCH_SECONDS } from "@/lib/domain/backup";
import { normalizeEmail } from "@/lib/domain/portal-users";

/**
 * What an administrator does to sign-in accounts from the command line, written so a script and a test can both call it.
 * (No "server-only" import on purpose: scripts/users.ts runs outside Next.)
 */

/** Who ran the command: the operating-system user on the machine it was run from. */
export function operatorName(): string {
  try {
    return userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

/** Records one thing an administrator did. Append-only. Never put a password, a hash or a token in `details`. */
export async function recordAccountEvent(
  db: Pick<PrismaClient, "accountEvent">,
  event: { action: string; targetUsername?: string | null; details?: Record<string, unknown> | null; actor?: string },
): Promise<void> {
  await db.accountEvent.create({
    data: {
      actor: event.actor ?? operatorName(),
      action: event.action,
      targetUsername: event.targetUsername ?? null,
      details: (event.details ?? undefined) as never,
    },
  });
}

/**
 * Signs everyone out, staff and customers, without changing any secret. Each session version is set to at least "now" counted from
 * 2026, which is above any version an account has reached (so a cookie issued before a restore, which a plain "one more" could
 * land on again, can never match).
 */
export async function endAllSessions(db: PrismaClient): Promise<{ staff: number; customers: number }> {
  const [staff, customers] = await db.$transaction([
    db.$executeRaw`UPDATE "AppUser" SET "sessionVersion" = GREATEST("sessionVersion" + 1, (floor(extract(epoch from now())) - ${SESSION_EPOCH_SECONDS})::int)`,
    db.$executeRaw`UPDATE "CustomerUser" SET "sessionVersion" = GREATEST("sessionVersion" + 1, (floor(extract(epoch from now())) - ${SESSION_EPOCH_SECONDS})::int)`,
  ]);
  await recordAccountEvent(db, { action: "end-all-sessions", details: { staff, customers } });
  return { staff, customers };
}

export class NoSuchContact extends Error {
  constructor(email: string) {
    super(`No customer contact has the email "${email}".`);
  }
}

/**
 * Erases a customer contact's personal details everywhere they are kept, for a genuine erasure request.
 *
 * The audit log is append-only, so its rows cannot be edited by the application (or by this tool's role, normally): the contact's
 * name and email are written into audit summaries ("Portal access offered to Dana (dana@...)"). This is the ONE controlled way
 * around that: inside a single transaction it switches the audit table's protection off, replaces the contact's name and email in
 * every audit row of THEIR customer with a placeholder, switches it back on, replaces the contact row's own details, ends their
 * sessions, and records the act. If anything fails the transaction rolls back, and the protection with it. It needs the role that
 * owns the tables (the same one that runs migrations), which is why it is a command-line tool and not part of the app.
 *
 * Backups taken earlier still hold the old details: see docs/PRODUCTION.md.
 */
export async function eraseContact(db: PrismaClient, rawEmail: string, actor: string = operatorName()): Promise<{ auditRows: number }> {
  const email = normalizeEmail(rawEmail);
  const contact = await db.customerUser.findUnique({ where: { email } });
  if (!contact) throw new NoSuchContact(email);
  const placeholderName = "[erased contact]";
  const placeholderEmail = `erased+${contact.id}@erased.invalid`;

  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "AuditEvent" DISABLE TRIGGER "AuditEvent_append_only"`);
      // The summary is plain text. `changes` is JSON, where a name with a quote or a backslash is written escaped, so the escaped form is
      // replaced too (to_json(text) gives the escaped form with its surrounding quotes, which substr removes).
      const auditRows = await tx.$executeRaw`
        UPDATE "AuditEvent" SET
          "summary" = replace(replace("summary", ${contact.email}, ${placeholderEmail}), ${contact.name}, ${placeholderName}),
          "changes" = CASE WHEN "changes" IS NULL THEN NULL ELSE
            replace(
              replace("changes"::text,
                substr(to_json(${contact.email}::text)::text, 2, length(to_json(${contact.email}::text)::text) - 2), ${placeholderEmail}),
              substr(to_json(${contact.name}::text)::text, 2, length(to_json(${contact.name}::text)::text) - 2), ${placeholderName})::jsonb
          END
        WHERE "customerId" = ${contact.customerId}
          AND (position(${contact.email} in "summary") > 0 OR position(${contact.name} in "summary") > 0
               OR position(${contact.email} in coalesce("changes"::text, '')) > 0 OR position(${contact.name} in coalesce("changes"::text, '')) > 0)`;
      await tx.$executeRawUnsafe(`ALTER TABLE "AuditEvent" ENABLE TRIGGER "AuditEvent_append_only"`);

      await tx.customerUser.update({
        where: { id: contact.id },
        data: {
          name: placeholderName,
          email: placeholderEmail,
          active: false,
          passwordHash: null,
          sessionVersion: { increment: 1 },
        },
      });
      await recordAccountEvent(tx, { action: "erase-contact", details: { contactId: contact.id, customerId: contact.customerId, auditRows }, actor });
      return { auditRows };
    },
    { timeout: 60_000, maxWait: 30_000 },
  );
}
