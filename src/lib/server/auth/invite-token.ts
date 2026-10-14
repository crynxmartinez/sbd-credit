import { createHash, randomBytes } from "node:crypto";

/**
 * An invitation link carries a random token. Only its SHA-256 hash is stored, so a copy of the database cannot be used
 * to accept anyone's invitation. 32 random bytes is far beyond guessing, so a plain fast hash is the right tool here
 * (a slow password hash protects low-entropy secrets, which this is not).
 */
const TOKEN_BYTES = 32;

export const hashInviteToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, hash: hashInviteToken(token) };
}
