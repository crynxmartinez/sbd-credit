import { describe, expect, test } from "vitest";
import { createHashSlots, HashQueueFull } from "./hash-slots";

const gate = () => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describe("createHashSlots", () => {
  test("runs at most `slots` password checks at once; the rest wait their turn", async () => {
    const slots = createHashSlots({ slots: 2, maxQueue: 10 });
    let running = 0;
    let peak = 0;
    const g = gate();
    const task = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await g.promise;
      running -= 1;
      return "done";
    };
    const results = Promise.all([slots.run(task), slots.run(task), slots.run(task), slots.run(task)]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(peak).toBe(2);
    g.release();
    expect(await results).toEqual(["done", "done", "done", "done"]);
  });

  test("when too many are already waiting it refuses at once instead of stacking up forever", async () => {
    const slots = createHashSlots({ slots: 1, maxQueue: 1 });
    const g = gate();
    const first = slots.run(() => g.promise);
    const second = slots.run(() => g.promise); // waits (queue of 1)
    await expect(slots.run(() => g.promise)).rejects.toBeInstanceOf(HashQueueFull);
    g.release();
    await Promise.all([first, second]);
  });

  test("a task that throws frees its slot for the next one", async () => {
    const slots = createHashSlots({ slots: 1, maxQueue: 5 });
    await expect(slots.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(slots.run(async () => "ok")).resolves.toBe("ok");
  });
});
