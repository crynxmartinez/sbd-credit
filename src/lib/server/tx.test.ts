import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * transaction() is where "nothing was saved" and "this may or may not have been saved" are decided. Both are promises made to a
 * person about their money, so each is tested with a database that fails in exactly the way that earns it.
 */
let outcome: "commit" | { reject: unknown } = "commit";
const executed: string[] = [];
vi.mock("./db", () => ({
  prisma: {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      if (outcome !== "commit") throw outcome.reject;
      return work({ $queryRaw: async (strings: TemplateStringsArray) => executed.push(strings.join("?")) });
    },
  },
}));
const logged: Array<{ level: string; event: string }> = [];
vi.mock("./log", () => ({ log: (level: string, event: string) => logged.push({ level, event }) }));

import { customerListCache } from "./list-cache";
import { transaction } from "./tx";

beforeEach(() => {
  outcome = "commit";
  executed.length = 0;
  logged.length = 0;
});

describe("transaction()", () => {
  test("returns what the work returned, after setting the lock and statement timeouts for this transaction only", async () => {
    expect(await transaction(async () => 42)).toBe(42);
    expect(executed[0]).toContain("lock_timeout");
    expect(executed[0]).toContain("statement_timeout");
  });

  test("a lock timeout or a deadlock is a 503 \"busy\": NOTHING was saved, and it says so", async () => {
    for (const reason of [{ code: "P2010", meta: { code: "55P03" } }, { code: "40P01" }, { code: "P2028" }, new Error("canceling statement due to lock timeout")]) {
      outcome = { reject: reason };
      await expect(transaction(async () => 1)).rejects.toMatchObject({ status: 503, code: "busy" });
    }
  });

  test("a dropped connection is a 503 \"interrupted\": it may or may not have been saved, and it must NOT claim nothing was", async () => {
    for (const reason of [{ code: "P1017" }, new Error("Connection terminated unexpectedly"), new Error("read ECONNRESET")]) {
      outcome = { reject: reason };
      const error = await transaction(async () => 1).then(() => null, (caught: unknown) => caught as { status: number; code: string; message: string });
      expect(error).toMatchObject({ status: 503, code: "interrupted" });
      expect(error!.message).toMatch(/may or may not have been saved/);
      expect(error!.message).not.toMatch(/nothing was saved/i);
    }
  });

  test("a rule the database enforces (a unique key, an append-only trigger) passes through untouched, so it can be mapped to its own message", async () => {
    const unique = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    outcome = { reject: unique };
    await expect(transaction(async () => 1)).rejects.toBe(unique);
  });

  test("an application error thrown by the work itself passes through untouched (and nothing is claimed about the database)", async () => {
    const mine = new Error("a rule was broken");
    await expect(transaction(async () => {
      throw mine;
    })).rejects.toBe(mine);
  });

  test("a connection problem is logged for the operator; an ordinary error is not logged as one", async () => {
    outcome = { reject: { code: "P1017" } };
    await transaction(async () => 1).catch(() => undefined);
    expect(logged).toContainEqual({ level: "warn", event: "tx.connection_problem" });
    logged.length = 0;
    outcome = { reject: Object.assign(new Error("x"), { code: "P2002" }) };
    await transaction(async () => 1).catch(() => undefined);
    expect(logged).toEqual([]);
  });

  test("every outcome, success or failure, tells the customer-list cache something may have changed", async () => {
    const compute = vi.fn(async () => "{}");
    await customerListCache.get("tx-test-a", compute);
    await transaction(async () => 1);
    await customerListCache.get("tx-test-a", compute);
    expect(compute).toHaveBeenCalledTimes(2); // recomputed after a commit

    outcome = { reject: { code: "P1017" } }; // a commit whose answer was lost
    await transaction(async () => 1).catch(() => undefined);
    await customerListCache.get("tx-test-a", compute);
    expect(compute).toHaveBeenCalledTimes(3);
  });
});
