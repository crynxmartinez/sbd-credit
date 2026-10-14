import { ROLES, isRole, type Role } from "./roles";

/** Rules for creating and changing sign-in accounts. Pure, so the same checks serve the command line and any future screen. */

export const MIN_PASSWORD_LENGTH = 12;
/** bcrypt only uses the first 72 bytes, so a longer password would silently be cut short. Refuse it instead. */
const MAX_PASSWORD_BYTES = 72;
/** The cost of every password hash. One place, so sign-in, invitations and the command-line tools always agree. */
export const BCRYPT_COST = 12;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export interface NewUser {
  username: string;
  name: string;
  role: Role;
  password: string;
}

/** Usernames are case-insensitive at sign-in, so they are stored lower-cased. */
export const normalizeUsername = (value: string): string => value.trim().toLowerCase();

/** What was typed on the sign-in page (a staff username or a customer email), made comparable: folded, trimmed, lower-cased. */
export const normalizeIdentifier = (value: string): string => value.normalize("NFKC").trim().toLowerCase();

/**
 * The letters of a password with everything else stripped, compared with these. "Password-1234", "password1234" and
 * "PASSWORD!" are all just "password". Kept short on purpose: it catches the guesses an attacker tries first, and the
 * company's own name, not every weak password.
 */
const COMMON_PASSWORD_WORDS: ReadonlySet<string> = new Set([
  "password", "passw", "qwerty", "qwertyuiop", "qwertyuiopasdf", "asdfghjkl", "zxcvbnm", "letmein", "welcome", "changeme",
  "iloveyou", "admin", "administrator", "login", "master", "monkey", "dragon", "sunshine", "princess", "football",
  "baseball", "superman", "trustno", "abcdefghijkl", "abcdefghijklmnop", "steel", "steelbuilding", "steelbuildingdepot",
  "depot", "credit", "creditapp", "credittracker",
]);

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORD_WORDS.has(password.toLowerCase().replace(/[^a-z]/g, ""));
}

export function validatePassword(password: string, username: string): string[] {
  const problems: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) problems.push(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) problems.push(`The password must be at most ${MAX_PASSWORD_BYTES} bytes long (accented and non-English characters count as more than one).`);
  if (username && password.toLowerCase().includes(username.toLowerCase())) problems.push("The password must not contain the username.");
  if (new Set(password).size < 4) problems.push("The password is too repetitive.");
  if (isCommonPassword(password)) problems.push("That password is too common. Choose something harder to guess.");
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
