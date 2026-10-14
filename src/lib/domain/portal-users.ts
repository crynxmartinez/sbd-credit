import { z } from "zod";
import type { CustomerStatus } from "./constants";
import { normalizeIdentifier } from "./users";

/** Rules for who may be given customer sign-in, and for their invitations. Pure, so a screen and a script share them. */

/** How long a first invitation works, and how long a reset link works for someone who already has a password. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 200;

/** Customers sign in with their email. Stored lower-cased, so one address is always one account. */
export const normalizeEmail = normalizeIdentifier;

const emailSchema = z.email();

/**
 * Everything wrong with a proposed contact, or an empty list. An email always contains "@", which a staff username can
 * never contain, so the two kinds of sign-in name can never be the same string.
 */
export function validateContact(input: { name: string; email: string }): string[] {
  const problems: string[] = [];
  const name = input.name.trim();
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) problems.push(`The name must be 1 to ${MAX_NAME_LENGTH} characters.`);
  const email = normalizeEmail(input.email);
  if (email.length > MAX_EMAIL_LENGTH || !emailSchema.safeParse(email).success) problems.push("Enter a valid email address.");
  return problems;
}

/** Only customers who have, or had, credit get a customer page to look at. */
export function canInviteTo(status: CustomerStatus): boolean {
  return status === "approved" || status === "suspended";
}

export type ContactStatus = "invited" | "active" | "disabled";

export function inviteStatus(contact: { active: boolean; hasPassword: boolean }): ContactStatus {
  if (!contact.active) return "disabled";
  return contact.hasPassword ? "active" : "invited";
}
