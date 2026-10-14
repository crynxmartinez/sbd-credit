/**
 * Development data. Runs only through `npm run seed:*`, which pins the database to the credit_dev schema.
 *
 *   npm run seed:admin   create (or refresh) the dev sign-in from .env.local
 *   npm run seed:demo    add a handful of fictional customers that exercise every alert (only into an empty database)
 *
 * Wipe everything and start clean with `npm run dev-db -- reset` followed by the migrate and seed commands.
 */
import { config } from "dotenv";
import bcrypt from "bcryptjs";
import { BCRYPT_COST } from "../src/lib/domain/users";
import { PrismaClient } from "../src/generated/prisma/client";
import { adapterFor } from "../src/lib/server/db-url";
import { addDays, dueDateFor, isoToDbDate, todayISO } from "../src/lib/domain/dates";

config({ path: ".env.local", quiet: true });

const ACTOR = "Demo seed";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set. Run this through `npm run seed:*`.");
const prisma = new PrismaClient({ adapter: adapterFor(connectionString, "development") });

async function seedAdmin(): Promise<void> {
  const username = process.env.DEV_ADMIN_USERNAME?.toLowerCase();
  const password = process.env.DEV_ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error("Set DEV_ADMIN_USERNAME and DEV_ADMIN_PASSWORD in .env.local first (see .env.example).");
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  await prisma.appUser.upsert({
    where: { username },
    update: { passwordHash, active: true, failedLogins: 0, lockedUntil: null, sessionVersion: { increment: 1 } },
    create: { username, name: "Dev Admin", role: "SUPERADMIN", passwordHash },
  });
  console.log(`dev sign-in ready for "${username}"`);
}

type Entry = { type: "CHARGE" | "PAYMENT"; cents: number; daysAgo: number; terms?: string; reference?: string };

interface DemoCustomer {
  businessName: string;
  contactName: string;
  phone: string;
  email: string;
  status: "submitted" | "under_review" | "approved" | "denied" | "suspended";
  appliedDaysAgo: number;
  limitCents: number;
  terms: string;
  entries: Entry[];
  history: string[];
  notes?: string;
}

const DEMO: DemoCustomer[] = [
  {
    businessName: "Midwest Fabrication LLC", contactName: "Dana Whitfield", phone: "(555) 201-4410", email: "dana@midwestfab.example",
    status: "approved", appliedDaysAgo: 120, limitCents: 50_000_00, terms: "Net 30",
    entries: [
      { type: "CHARGE", cents: 18_500_00, daysAgo: 40, reference: "INV-1042" },
      { type: "CHARGE", cents: 12_250_50, daysAgo: 10, reference: "INV-1067" },
      { type: "PAYMENT", cents: 5_000_00, daysAgo: 5, reference: "Check 7731" },
    ],
    history: ["Application created", "Approved — $50,000 at Net 30"],
    notes: "Pays by check. Prefers invoices emailed to accounting.",
  },
  {
    businessName: "Lakeside Builders Inc.", contactName: "Marcus Ortega", phone: "(555) 310-8822", email: "marcus@lakesidebuilders.example",
    status: "approved", appliedDaysAgo: 200, limitCents: 25_000_00, terms: "Net 30",
    entries: [
      { type: "CHARGE", cents: 21_400_00, daysAgo: 20, reference: "INV-1055" },
      { type: "CHARGE", cents: 1_200_00, daysAgo: 26, reference: "INV-1049" },
    ],
    history: ["Application created", "Moved to under review", "Approved — $25,000 at Net 30"],
  },
  {
    businessName: "Ridgeline Metal Works", contactName: "Priya Nair", phone: "(555) 744-0193", email: "priya@ridgelinemetal.example",
    status: "approved", appliedDaysAgo: 90, limitCents: 15_000_00, terms: "Net 15",
    entries: [{ type: "CHARGE", cents: 16_800_00, daysAgo: 30, reference: "INV-1031" }],
    history: ["Application created", "Approved — $15,000 at Net 15"],
  },
  {
    businessName: "Summit Roofing Co.", contactName: "Tom Haverty", phone: "(555) 902-3317", email: "tom@summitroofing.example",
    status: "approved", appliedDaysAgo: 300, limitCents: 75_000_00, terms: "Net 45",
    entries: [{ type: "CHARGE", cents: 8_000_00, daysAgo: 5, reference: "INV-1070" }],
    history: ["Application created", "Approved — $75,000 at Net 45"],
  },
  {
    businessName: "Prairie Ag Supply", contactName: "Elena Brandt", phone: "(555) 618-2204", email: "elena@prairieag.example",
    status: "submitted", appliedDaysAgo: 8, limitCents: 0, terms: "Net 30", entries: [], history: ["Application created"],
  },
  {
    businessName: "Cedar Valley Contractors", contactName: "Sam Okafor", phone: "(555) 455-9071", email: "sam@cedarvalley.example",
    status: "under_review", appliedDaysAgo: 3, limitCents: 0, terms: "Net 30", entries: [],
    history: ["Application created", "Moved to under review"],
  },
  {
    businessName: "Northgate Storage LLC", contactName: "Rita Alvarez", phone: "(555) 380-6615", email: "rita@northgatestorage.example",
    status: "denied", appliedDaysAgo: 20, limitCents: 0, terms: "Net 30", entries: [],
    history: ["Application created", "Moved to under review", "Denied — insufficient trade references"],
  },
  {
    businessName: "Harbor Steel Erectors", contactName: "Jim Calloway", phone: "(555) 267-5540", email: "jim@harborsteel.example",
    status: "suspended", appliedDaysAgo: 400, limitCents: 30_000_00, terms: "Net 30",
    entries: [{ type: "CHARGE", cents: 9_500_00, daysAgo: 75, reference: "INV-0988" }],
    history: ["Application created", "Approved — $30,000 at Net 30", "Credit suspended — 45 days past due"],
  },
];

async function seedDemo(): Promise<void> {
  if ((await prisma.customer.count()) > 0) {
    console.log("customers already exist; skipping demo data (reset the dev schema to start over)");
    return;
  }
  const today = todayISO();
  const ago = (days: number) => addDays(today, -days);

  for (const demo of DEMO) {
    const applied = ago(demo.appliedDaysAgo);
    await prisma.customer.create({
      data: {
        businessName: demo.businessName,
        contactName: demo.contactName,
        phone: demo.phone,
        email: demo.email,
        status: demo.status,
        dateApplied: isoToDbDate(applied),
        statusChangedOn: isoToDbDate(applied),
        creditLimitCents: demo.limitCents,
        paymentTerms: demo.terms,
        creditStartDate: demo.limitCents > 0 ? isoToDbDate(applied) : null,
        notes: demo.notes ?? null,
        ledger: {
          create: demo.entries.map((entry) => {
            const entryDate = ago(entry.daysAgo);
            return {
              type: entry.type,
              amountCents: entry.cents,
              entryDate: isoToDbDate(entryDate),
              dueDate: entry.type === "CHARGE" ? isoToDbDate(dueDateFor(entryDate, demo.terms)) : null,
              reference: entry.reference ?? null,
              createdBy: ACTOR,
            };
          }),
        },
        audit: { create: demo.history.map((summary) => ({ action: "demo.history", summary, actor: ACTOR })) },
      },
    });
  }
  console.log(`added ${DEMO.length} demo customers`);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (!["admin", "demo", "all"].includes(mode ?? "")) {
    console.error("usage: tsx scripts/seed.ts <admin|demo|all>");
    process.exitCode = 2;
    return;
  }
  if (mode === "admin" || mode === "all") await seedAdmin();
  if (mode === "demo" || mode === "all") await seedDemo();
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
