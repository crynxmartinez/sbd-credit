/**
 * Manage sign-in accounts. There is no screen for this on purpose: who can see customer credit is an administrator's
 * decision, made from a terminal.
 *
 *   npm run user -- list
 *   npm run user -- create <username> "<Full Name>" <EMPLOYEE|ADMIN|SUPERADMIN>
 *   npm run user -- reset-password <username>
 *   npm run user -- deactivate <username>
 *   npm run user -- activate <username>
 *
 * The password comes from the NEW_USER_PASSWORD environment variable. If it is not set, a strong random one is made and
 * shown ONCE, here, so it never has to travel through chat or email in a form someone chose in a hurry.
 * Against production: NODE_ENV=production DATABASE_URL=<...?schema=credit> npx tsx scripts/users.ts <command>
 */
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma/client";
import { normalizeUsername, validateNewUser, validatePassword } from "../src/lib/domain/users";
import { adapterFor } from "../src/lib/server/db-url";

const BCRYPT_COST = 12;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set. Run this through `npm run user`.");
const environment = process.env.NODE_ENV === "production" ? "production" : "development";
const prisma = new PrismaClient({ adapter: adapterFor(connectionString, environment) });

const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

/** The password from the environment, or a fresh random one that is shown once. */
function passwordFor(): { password: string; generated: boolean } {
  const supplied = process.env.NEW_USER_PASSWORD;
  if (supplied) return { password: supplied, generated: false };
  return { password: randomBytes(18).toString("base64url"), generated: true };
}

async function create(args: string[]): Promise<void> {
  const [rawUsername, name, role] = args;
  if (!rawUsername || !name || !role) fail('usage: npm run user -- create <username> "<Full Name>" <ROLE>');
  const username = normalizeUsername(rawUsername as string);
  const { password, generated } = passwordFor();

  const problems = validateNewUser({ username, name: name as string, role: role as string, password });
  if (problems.length > 0) fail(problems.join("\n"));
  if (await prisma.appUser.findUnique({ where: { username } })) fail(`The username "${username}" is already taken.`);

  await prisma.appUser.create({
    data: { username, name: (name as string).trim(), role: role as string, passwordHash: await bcrypt.hash(password, BCRYPT_COST) },
  });
  console.log(`created ${role} account "${username}"`);
  if (generated) console.log(`one-time password (shown only now): ${password}`);
}

async function resetPassword(args: string[]): Promise<void> {
  const username = normalizeUsername(args[0] ?? "");
  if (!username) fail("usage: npm run user -- reset-password <username>");
  const user = await prisma.appUser.findUnique({ where: { username } });
  if (!user) return fail(`No account named "${username}".`);

  const { password, generated } = passwordFor();
  const problems = validatePassword(password, username);
  if (problems.length > 0) fail(problems.join("\n"));

  await prisma.appUser.update({
    where: { id: user.id },
    // A new password signs the person out everywhere and clears any lockout.
    data: { passwordHash: await bcrypt.hash(password, BCRYPT_COST), sessionVersion: { increment: 1 }, failedLogins: 0, lockedUntil: null },
  });
  console.log(`password changed for "${username}" and all their sessions ended`);
  if (generated) console.log(`one-time password (shown only now): ${password}`);
}

async function setActive(args: string[], active: boolean): Promise<void> {
  const username = normalizeUsername(args[0] ?? "");
  if (!username) fail(`usage: npm run user -- ${active ? "activate" : "deactivate"} <username>`);
  const user = await prisma.appUser.findUnique({ where: { username } });
  if (!user) return fail(`No account named "${username}".`);
  await prisma.appUser.update({
    where: { id: user.id },
    // Deactivating also ends every session they have open.
    data: { active, ...(active ? {} : { sessionVersion: { increment: 1 } }) },
  });
  console.log(`${active ? "activated" : "deactivated"} "${username}"`);
}

async function list(): Promise<void> {
  const users = await prisma.appUser.findMany({ orderBy: { username: "asc" } });
  if (users.length === 0) console.log("no accounts yet");
  for (const user of users) {
    console.log(`${user.username.padEnd(24)} ${user.role.padEnd(10)} ${user.active ? "active" : "DEACTIVATED"}  ${user.name}`);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "list":
      return list();
    case "create":
      return create(args);
    case "reset-password":
      return resetPassword(args);
    case "deactivate":
      return setActive(args, false);
    case "activate":
      return setActive(args, true);
    default:
      return fail("usage: npm run user -- <list|create|reset-password|deactivate|activate> ...");
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
