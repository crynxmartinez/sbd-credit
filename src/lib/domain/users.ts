import { ROLES, isRole, type Role } from "./roles";

/** Rules for creating and changing sign-in accounts. Pure, so the same checks serve the command line and any future screen. */

export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export interface NewUser {
  username: string;
  name: string;
  role: Role;
  password: string;
}

/** Usernames are case-insensitive at sign-in, so they are stored lower-cased. */
export const normalizeUsername = (value: string): string => value.trim().toLowerCase();

export function validatePassword(password: string, username: string): string[] {
  const problems: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) problems.push(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (password.length > MAX_PASSWORD_LENGTH) problems.push(`The password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  if (username && password.toLowerCase().includes(username.toLowerCase())) problems.push("The password must not contain the username.");
  if (new Set(password).size < 4) problems.push("The password is too repetitive.");
  return problems;
}

/** Everything wrong with a proposed new user, or an empty list when it is fine. */
export function validateNewUser(input: { username: string; name: string; role: string; password: string }): string[] {
  const problems: string[] = [];
  const username = normalizeUsername(input.username);
  if (!USERNAME_PATTERN.test(username)) {
    problems.push("The username must be 3 to 32 characters: letters, digits, dots, dashes and underscores, starting with a letter or digit.");
  }
  if (input.name.trim().length < 1 || input.name.trim().length > 120) problems.push("The name must be 1 to 120 characters.");
  if (!isRole(input.role)) problems.push(`The role must be one of ${ROLES.join(", ")}.`);
  problems.push(...validatePassword(input.password, username));
  return problems;
}
