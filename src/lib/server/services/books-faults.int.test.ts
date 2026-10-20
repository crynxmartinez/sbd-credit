import { randomUUID } from "node:crypto";
import net from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { addDays } from "@/lib/domain/dates";
import { ApiError } from "@/lib/server/http";
import { assertBooksAgree } from "@/test/books-oracle";
import type { SessionUser } from "@/lib/types";
import type { CustomerCreateInput, LedgerEntryInput } from "@/lib/validation";
import { businessToday } from "../as-of";
import { createCustomer, decide } from "./customers";
import { recordEntry, reverseEntry } from "./ledger";

/**
 * The connection to the database is cut at the worst possible moments, by a TCP proxy that sits between the application and Postgres:
 *
 *   - while the entry is being written (before it could have committed),
 *   - at the instant the commit is sent (before the server has seen it),
 *   - after the server has COMMITTED but before the answer reaches the application (the case no application can see coming).
 *
 * What must hold: the person is never told "nothing was saved" when it was; what is in the database is all of a write or none of it;
 * and sending the same submission again (as the person is told to check, and the browser retries) records it exactly once.
 */
const ADMIN: SessionUser = { id: "u-fault-admin", username: "fault-admin", name: "Fault Admin", role: "ADMIN" };
const TODAY = businessToday();
const clock = { today: () => TODAY, now: () => new Date() };

type Fault = "cut_while_writing" | "cut_before_commit" | "lose_commit_answer" | null;

interface Proxy {
  port: number;
  arm: (fault: Fault) => void;
  fired: () => number;
  close: () => Promise<void>;
}

function startProxy(upstreamHost: string, upstreamPort: number): Promise<Proxy> {
  let armed: Fault = null;
  let fires = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(upstreamPort, upstreamHost);
    sockets.add(client);
    sockets.add(upstream);
    let swallowAnswer = false;
    const cut = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());

    client.on("data", (chunk: Buffer) => {
      const text = chunk.toString("latin1");
      if (armed === "cut_while_writing" && text.includes("INSERT INTO") && text.includes("LedgerEntry")) {
        armed = null;
        fires += 1;
        cut();
        return;
      }
      if (armed && armed !== "cut_while_writing" && /(^|\0|[^A-Za-z])COMMIT\0/.test(text)) {
        const fault = armed;
        armed = null;
        fires += 1;
        if (fault === "cut_before_commit") {
          cut();
          return;
        }
        swallowAnswer = true; // forward the COMMIT, then never let the answer through
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      if (swallowAnswer) {
        // The server has now answered the COMMIT: it is durable. The application never hears about it.
        swallowAnswer = false;
        cut();
        return;
      }
      client.write(chunk);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        arm: (fault) => { armed = fault; },
        fired: () => fires,
        close: () => new Promise<void>((done) => { for (const socket of sockets) socket.destroy(); server.close(() => done()); }),
      });
    });
  });
}

let proxy: Proxy;
let direct: pg.Client;
let schema: string;

const profile = (name: string): CustomerCreateInput => ({
  businessName: name, contactName: null, phone: null, email: null, billingAddress: null, dateApplied: "2026-10-01",
  requestedLimitCents: null, accountingAppName: null, accountingProjectUrl: null, notes: null,
});
const payment = (amountCents: number, requestKey: string): LedgerEntryInput => ({
  type: "PAYMENT", amountCents, entryDate: TODAY, dueDate: null, reference: "CHK-FAULT", note: null, requestKey,
});
const charge = (amountCents: number): LedgerEntryInput => ({ type: "CHARGE", amountCents, entryDate: addDays(TODAY, -3), dueDate: null, reference: null, note: null });

async function newCustomer(): Promise<string> {
  const id = await createCustomer(profile(`Fault ${randomUUID().slice(0, 8)}`), ADMIN);
  await decide(id, { action: "approve", version: 1, creditLimitCents: 1_000_000, paymentTerms: "Net 30", creditStartDate: "2026-10-01" }, ADMIN);
  return id;
}

/** What is really in the database, read over a connection that does not go through the proxy. */
async function truth(customerId: string, requestKey: string): Promise<{ rows: number; audit: number }> {
  const ledger = await direct.query(`SELECT count(*)::int AS n FROM "${schema}"."LedgerEntry" WHERE "customerId" = $1 AND "requestKey" = $2`, [customerId, requestKey]);
  const audit = await direct.query(`SELECT count(*)::int AS n FROM "${schema}"."AuditEvent" a JOIN "${schema}"."LedgerEntry" e ON e."id" = a."ledgerEntryId" WHERE e."customerId" = $1 AND e."requestKey" = $2`, [customerId, requestKey]);
  return { rows: ledger.rows[0].n, audit: audit.rows[0].n };
}

const failure = async (work: Promise<unknown>): Promise<ApiError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw new Error(`not a clean refusal: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
  throw new Error("the write was reported as successful, but the connection was cut");
};

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  schema = url.searchParams.get("schema") ?? "credit_test";
  proxy = await startProxy(url.hostname, Number(url.port || 5432));
  const direct_url = new URL(url);
  direct_url.searchParams.delete("schema");
  direct = new pg.Client({ connectionString: direct_url.toString() });
  await direct.connect();
  // From here on the application talks to the database through the proxy. (The client is created on first use, so this is in time.)
  const through = new URL(url);
  through.hostname = "127.0.0.1";
  through.port = String(proxy.port);
  process.env.DATABASE_URL = through.toString();
});
afterAll(async () => {
  await direct?.end();
  await proxy?.close();
});
beforeEach(() => proxy.arm(null));

describe("the connection is cut while saving", () => {
  test("cut while the entry is being written: nothing is left behind, and the person is told it may not have been saved", async () => {
    const id = await newCustomer();
    const key = randomUUID();
    proxy.arm("cut_while_writing");
    const error = await failure(recordEntry(id, payment(25_00, key), ADMIN, clock));
    expect(proxy.fired()).toBeGreaterThan(0);
    expect(error.status).toBe(503);
    expect(error.code).toMatch(/interrupted|busy/);
    expect(await truth(id, key)).toEqual({ rows: 0, audit: 0 });
    // The system carries on, and the same submission now goes through once.
    await recordEntry(id, charge(100_00), ADMIN, clock);
    const again = await recordEntry(id, payment(25_00, key), ADMIN, clock);
    expect(again.duplicate).toBe(false);
    expect(await truth(id, key)).toEqual({ rows: 1, audit: 1 });
    await assertBooksAgree(id, "after a cut while writing", TODAY);
  });

  test("cut at the moment of COMMIT, before the server saw it: nothing saved, and the answer is honest about not knowing", async () => {
    const id = await newCustomer();
    await recordEntry(id, charge(100_00), ADMIN, clock);
    const key = randomUUID();
    proxy.arm("cut_before_commit");
    const error = await failure(recordEntry(id, payment(40_00, key), ADMIN, clock));
    expect(proxy.fired()).toBeGreaterThan(0);
    expect(error.status).toBe(503);
    expect(error.message).toMatch(/may or may not|nothing was saved/i);
    expect(await truth(id, key)).toEqual({ rows: 0, audit: 0 });
    await assertBooksAgree(id, "after a cut before commit", TODAY);
  });

  test("the server COMMITTED but the answer was lost: the person is NEVER told nothing was saved, and resending records it exactly once", async () => {
    const id = await newCustomer();
    await recordEntry(id, charge(100_00), ADMIN, clock);
    const key = randomUUID();
    proxy.arm("lose_commit_answer");
    const error = await failure(recordEntry(id, payment(40_00, key), ADMIN, clock));
    expect(proxy.fired()).toBeGreaterThan(0);

    // The database has the payment: the write really happened.
    expect(await truth(id, key)).toEqual({ rows: 1, audit: 1 });
    // So the answer must not say otherwise.
    expect(error.status).toBe(503);
    expect(error.message, "told the person nothing was saved when it was").not.toMatch(/nothing was saved/i);
    expect(error.message).toMatch(/may or may not/i);

    // The person (or the browser) sends it again: it is recognised, not recorded twice.
    const retry = await recordEntry(id, payment(40_00, key), ADMIN, clock);
    expect(retry.duplicate).toBe(true);
    expect(await truth(id, key)).toEqual({ rows: 1, audit: 1 });
    await assertBooksAgree(id, "after a lost commit answer and a retry", TODAY);
  });

  test("a reversal whose commit answer is lost is also recorded once when sent again", async () => {
    const id = await newCustomer();
    const target = await recordEntry(id, charge(55_00), ADMIN, clock);
    const key = randomUUID();
    proxy.arm("lose_commit_answer");
    const error = await failure(reverseEntry(id, target.id, { reason: "Billed twice", requestKey: key }, ADMIN, clock));
    expect(error.message).not.toMatch(/nothing was saved/i);
    const retry = await reverseEntry(id, target.id, { reason: "Billed twice", requestKey: key }, ADMIN, clock);
    expect(retry.duplicate).toBe(true);
    const rows = await direct.query(`SELECT count(*)::int AS n FROM "${schema}"."LedgerEntry" WHERE "reversesEntryId" = $1`, [target.id]);
    expect(rows.rows[0].n).toBe(1);
    await assertBooksAgree(id, "after a lost reversal answer and a retry", TODAY);
  });

  test("after every kind of cut the pool recovers: a normal write goes through and the books agree", async () => {
    const id = await newCustomer();
    for (const fault of ["cut_while_writing", "cut_before_commit", "lose_commit_answer"] as const) {
      proxy.arm(fault);
      await failure(recordEntry(id, payment(1_00, randomUUID()), ADMIN, clock)).catch(() => undefined);
      await recordEntry(id, charge(10_00), ADMIN, clock);
    }
    await assertBooksAgree(id, "after all the cuts", TODAY);
  });
});
