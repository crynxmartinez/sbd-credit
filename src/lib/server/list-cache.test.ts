import { describe, expect, test } from "vitest";
import { createListCache } from "./list-cache";

function harness(ttlMs = 10_000) {
  let now = 1_000;
  let calls = 0;
  const cache = createListCache({ ttlMs, now: () => now });
  const compute = (body: string) => async () => {
    calls += 1;
    return body;
  };
  return { cache, compute, advance: (ms: number) => { now += ms; }, calls: () => calls };
}

describe("createListCache", () => {
  test("computes once and then serves the same answer until something is written", async () => {
    const h = harness();
    const first = await h.cache.get("2026-10-20", h.compute('{"a":1}'));
    const second = await h.cache.get("2026-10-20", h.compute('{"a":2}')); // would differ, but it is not computed
    expect(second.body).toBe('{"a":1}');
    expect(second.etag).toBe(first.etag);
    expect(h.calls()).toBe(1);
  });

  test("a write (bump) makes the next read compute again", async () => {
    const h = harness();
    await h.cache.get("d", h.compute("one"));
    h.cache.bump();
    expect((await h.cache.get("d", h.compute("two"))).body).toBe("two");
    expect(h.calls()).toBe(2);
  });

  test("the answer expires after the time limit, which covers writes made by another server", async () => {
    const h = harness(10_000);
    await h.cache.get("d", h.compute("one"));
    h.advance(9_999);
    expect((await h.cache.get("d", h.compute("two"))).body).toBe("one");
    h.advance(2);
    expect((await h.cache.get("d", h.compute("two"))).body).toBe("two");
  });

  test("many readers at once cost ONE computation (single flight)", async () => {
    const h = harness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const slow = async () => {
      calls += 1;
      await gate;
      return "shared";
    };
    const readers = Array.from({ length: 25 }, () => h.cache.get("d", slow));
    release();
    const results = await Promise.all(readers);
    expect(calls).toBe(1);
    expect(new Set(results.map((r) => r.body))).toEqual(new Set(["shared"]));
  });

  test("a computation that a write overtook is returned to its readers but NOT kept for later ones", async () => {
    const h = harness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = async () => {
      await gate;
      return "computed-before-the-write";
    };
    const pending = h.cache.get("d", slow);
    h.cache.bump(); // a write commits while it was computing
    release();
    expect((await pending).body).toBe("computed-before-the-write");
    expect((await h.cache.get("d", h.compute("fresh"))).body).toBe("fresh");
  });

  test("the etag follows the content: the same body always has the same etag, a different one does not", async () => {
    const a = harness();
    const b = harness();
    const one = await a.cache.get("d", a.compute("same body"));
    const two = await b.cache.get("d", b.compute("same body"));
    const three = await b.cache.get("e", b.compute("another body"));
    expect(one.etag).toBe(two.etag);
    expect(three.etag).not.toBe(one.etag);
    expect(one.etag).toMatch(/^W\/"[0-9a-f]{16}"$/);
  });

  test("a failed computation is not cached and does not break the next read", async () => {
    const h = harness();
    await expect(h.cache.get("d", async () => {
      throw new Error("database down");
    })).rejects.toThrow("database down");
    expect((await h.cache.get("d", h.compute("ok"))).body).toBe("ok");
  });

  test("only a few days are remembered, so the cache cannot grow", async () => {
    const h = harness();
    for (const day of ["a", "b", "c", "d", "e", "f"]) await h.cache.get(day, h.compute(day));
    expect(h.cache.size()).toBeLessThanOrEqual(3);
  });
});
