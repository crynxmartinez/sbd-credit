import "server-only";
import bcrypt from "bcryptjs";
import type { Prisma } from "@/generated/prisma/client";
import type { CustomerStatus } from "@/lib/domain/constants";
import { INVITE_TTL_MS, RESET_TTL_MS, canInviteTo, inviteStatus, normalizeEmail, validateContact } from "@/lib/domain/portal-users";
import { can } from "@/lib/domain/roles";
import { BCRYPT_COST, validatePassword } from "@/lib/domain/users";
import type { PortalContactDto, SessionUser } from "@/lib/types";
import { hashInviteToken, newInviteToken } from "../auth/invite-token";
import { prisma } from "../db";
import { ApiError } from "../http";
import { transaction } from "../tx";
import { writeAudit } from "./audit";

export interface IssuedInvite {
  contact: PortalContactDto;
  /** The one-time secret. Shown once to the admin and never stored, logged or listed. */
  token: string;
  expiresAt: string;
}

const MIN_NAME_LENGTH_FOR_PASSWORD_CHECK = 4;

const invalidInvite = () =>
  new ApiError(400, "invalid_invite", "This link is not valid or has expired. If you have already set your password, just sign in. Otherwise ask us to send you a new link.");
const notFound = () => new ApiError(404, "not_found", "That contact no longer exists.");

function assertAdmin(actor: SessionUser): void {
  if (!can(actor.role, "portal.manage")) throw new ApiError(403, "forbidden", "Only an admin can manage customer sign-in.");
}

const CONTACT_SELECT = {
  id: true,
  name: true,
  email: true,
  active: true,
  passwordHash: true,
  lastLoginAt: true,
  invites: { where: { usedAt: null, revokedAt: null }, select: { expiresAt: true }, orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }], take: 1 },
} satisfies Prisma.CustomerUserSelect;

type ContactRow = Prisma.CustomerUserGetPayload<{ select: typeof CONTACT_SELECT }>;

function toContactDto(row: ContactRow, now: Date): PortalContactDto {
  const live = row.invites[0];
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    status: inviteStatus({ active: row.active, hasPassword: row.passwordHash !== null }),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    inviteExpiresAt: live && live.expiresAt.getTime() > now.getTime() ? live.expiresAt.toISOString() : null,
  };
}

export async function listContacts(customerId: string, actor: SessionUser, now: Date = new Date()): Promise<PortalContactDto[]> {
  assertAdmin(actor);
  const rows = await prisma.customerUser.findMany({ where: { customerId }, select: CONTACT_SELECT, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map((row) => toContactDto(row, now));
}

/**
 * Locks one contact's row for the rest of the transaction, scoped to the customer in the path, so accepting, re-sending and
 * disabling can never interleave. A contact that belongs to a different customer is simply not found.
 */
async function lockContact(tx: Prisma.TransactionClient, customerId: string, contactId: string) {
  const rows = await tx.$queryRaw<{ name: string; email: string; active: boolean; hasPassword: boolean }[]>`
    UPDATE "CustomerUser" SET "updatedAt" = now()
    WHERE "id" = ${contactId} AND "customerId" = ${customerId}
    RETURNING "name", "email", "active", ("passwordHash" IS NOT NULL) AS "hasPassword"`;
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

async function readContact(tx: Prisma.TransactionClient, contactId: string, now: Date): Promise<PortalContactDto> {
  const row = await tx.customerUser.findUniqueOrThrow({ where: { id: contactId }, select: CONTACT_SELECT });
  return toContactDto(row, now);
}

async function createInvite(tx: Prisma.TransactionClient, contactId: string, actor: SessionUser, ttlMs: number, now: Date) {
  const { token, hash } = newInviteToken();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await tx.portalInvite.create({
    // createdAt comes from the same clock as expiresAt, so the database's "expires after it was created" rule holds for any `now`.
    data: { customerUserId: contactId, tokenHash: hash, expiresAt, createdAt: now, createdBy: actor.name, createdById: actor.id },
  });
  return { token, expiresAt };
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

/** Offers portal access to a person at a customer. Returns the one-time link secret for the admin to pass on. */
export async function inviteContact(
  customerId: string,
  input: { name: string; email: string },
  actor: SessionUser,
  now: Date = new Date(),
): Promise<IssuedInvite> {
  assertAdmin(actor);
  const problems = validateContact(input);
  if (problems.length > 0) throw new ApiError(422, "invalid_contact", problems[0] ?? "Check the name and email.");
  const email = normalizeEmail(input.email);
  const name = input.name.trim();

  try {
    return await transaction(async (tx) => {
      // FOR SHARE: a status change waits for this short transaction. (It also conflicts with the row lock a ledger write takes, so
      // a ledger write waits for this short transaction too, up to the lock timeout.)
      const [customer] = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "Customer" WHERE "id" = ${customerId} FOR SHARE`;
      if (!customer) throw new ApiError(404, "not_found", "That customer no longer exists.");
      if (!canInviteTo(customer.status as CustomerStatus)) {
        throw new ApiError(409, "invalid_state", "Portal access can only be offered once an account is approved.");
      }

      const created = await tx.customerUser.create({ data: { customerId, email, name, createdBy: actor.name, createdById: actor.id } });
      const { token, expiresAt } = await createInvite(tx, created.id, actor, INVITE_TTL_MS, now);
      await writeAudit(tx, { customerId, action: "portal.invited", summary: `Portal access offered to ${name} (${email})`, actor: actor.name, actorId: actor.id });
      return { contact: await readContact(tx, created.id, now), token, expiresAt: expiresAt.toISOString() };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // This is also what a double click, or a retry after a lost reply, looks like: the first one worked and its link is gone.
      throw new ApiError(409, "already_exists", "That email address already has portal access. If you just created it and lost the link, use \"New link\" on that person.");
    }
    throw error;
  }
}

/**
 * Sends a new link, cancelling any older one. Everyone signed in as that contact is signed out. If they already have a
 * password it keeps working until the new link is used, so a reset never locks out someone who simply asked for help.
 */
export async function reissueInvite(customerId: string, contactId: string, actor: SessionUser, now: Date = new Date()): Promise<IssuedInvite> {
  assertAdmin(actor);
  return transaction(async (tx) => {
    const contact = await lockContact(tx, customerId, contactId);
    if (!contact.active) throw new ApiError(409, "disabled", "This person's access is turned off. Turn it on before sending a new link.");

    await tx.portalInvite.updateMany({ where: { customerUserId: contactId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
    await tx.customerUser.update({ where: { id: contactId }, data: { sessionVersion: { increment: 1 } } });
    const { token, expiresAt } = await createInvite(tx, contactId, actor, contact.hasPassword ? RESET_TTL_MS : INVITE_TTL_MS, now);
    await writeAudit(tx, {
      customerId,
      action: "portal.invite_resent",
      summary: `${contact.hasPassword ? "Password reset link" : "New invitation"} sent to ${contact.name} (${contact.email})`,
      actor: actor.name,
      actorId: actor.id,
    });
    return { contact: await readContact(tx, contactId, now), token, expiresAt: expiresAt.toISOString() };
  });
}

/** Turns a person's access off or on. Turning it off signs them out everywhere and cancels any live link. */
export async function setContactActive(customerId: string, contactId: string, active: boolean, actor: SessionUser, now: Date = new Date()): Promise<PortalContactDto> {
  assertAdmin(actor);
  return transaction(async (tx) => {
    const contact = await lockContact(tx, customerId, contactId);
    if (contact.active === active) return readContact(tx, contactId, now);

    await tx.customerUser.update({ where: { id: contactId }, data: { active, sessionVersion: { increment: 1 }, failedLogins: 0, lockedUntil: null } });
    if (!active) await tx.portalInvite.updateMany({ where: { customerUserId: contactId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
    await writeAudit(tx, {
      customerId,
      action: active ? "portal.enabled" : "portal.disabled",
      summary: `Portal access ${active ? "turned on" : "turned off"} for ${contact.name} (${contact.email})`,
      actor: actor.name,
      actorId: actor.id,
    });
    return readContact(tx, contactId, now);
  });
}

/**
 * Uses an invitation link to set a password. Safe against every race: the contact's row is locked, the link is consumed
 * by a single conditional update that must change exactly one row, and the password is set in the same transaction, so ten
 * simultaneous attempts leave exactly one winner, and an older link can never take over after a newer one was sent.
 * Every way a link can be unusable (unknown, used, replaced, expired, person disabled) gives the same answer.
 */
export async function acceptInvite(token: string, password: string, now: Date = new Date()): Promise<void> {
  const problems = validatePassword(password, "");
  if (problems.length > 0) throw new ApiError(422, "weak_password", problems[0] ?? "Choose a stronger password.");

  const tokenHash = hashInviteToken(token);
  // Cheap existence check first, so a made-up link costs us no password hashing.
  const exists = await prisma.portalInvite.findUnique({ where: { tokenHash }, select: { id: true } });
  if (!exists) throw invalidInvite();
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  await transaction(async (tx) => {
    const invite = await tx.portalInvite.findUnique({ where: { tokenHash }, select: { id: true, customerUserId: true } });
    if (!invite) throw invalidInvite();

    const rows = await tx.$queryRaw<{ customerId: string; name: string; email: string; active: boolean }[]>`
      UPDATE "CustomerUser" SET "updatedAt" = now()
      WHERE "id" = ${invite.customerUserId}
      RETURNING "customerId", "name", "email", "active"`;
    const contact = rows[0];
    if (!contact || !contact.active) throw invalidInvite();

    const consumed = await tx.portalInvite.updateMany({
      where: { id: invite.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) throw invalidInvite();

    // Thrown after the link is marked used, inside the transaction: the failure rolls the link back, so it can be retried.
    // A very short name (al@co.com) would rule out ordinary words, so only a reasonably long one is checked against the password.
    const local = contact.email.split("@")[0] ?? "";
    const checkedName = local.length >= MIN_NAME_LENGTH_FOR_PASSWORD_CHECK ? local : "";
    if (validatePassword(password, checkedName).length > 0 || password.toLowerCase().includes(contact.email)) {
      throw new ApiError(422, "weak_password", "The password must not contain your email address.");
    }

    await tx.customerUser.update({
      where: { id: invite.customerUserId },
      data: { passwordHash, sessionVersion: { increment: 1 }, failedLogins: 0, lockedUntil: null },
    });
    await writeAudit(tx, {
      customerId: contact.customerId,
      action: "portal.accepted",
      summary: `${contact.name} (${contact.email}) set a password and can now sign in`,
      actor: contact.name,
      actorId: invite.customerUserId,
      actorKind: "customer",
    });
  });
}
