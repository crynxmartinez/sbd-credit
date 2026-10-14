/**
 * Password hashing is deliberately slow (about half a second of CPU) and, here, runs on the one thread that also serves
 * every other request. A burst of sign-in attempts from many addresses would therefore stall the whole app. This caps how
 * many hashes run at once, lets a few more wait, and refuses the rest at once, so a flood costs the flooder a refusal
 * instead of costing everyone else their page.
 */
export class HashQueueFull extends Error {
  constructor() {
    super("Too many sign-in attempts are being processed.");
  }
}

interface Options {
  /** Hashes that may run at the same time. */
  slots: number;
  /** Hashes allowed to wait for a slot. Beyond this a request is refused immediately. */
  maxQueue: number;
}

export function createHashSlots({ slots, maxQueue }: Options) {
  let running = 0;
  const waiting: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (running < slots) {
      running += 1;
      return;
    }
    if (waiting.length >= maxQueue) throw new HashQueueFull();
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function release(): void {
    const next = waiting.shift();
    // Hand the slot straight to the next waiter, so `running` never dips and lets a newcomer jump the queue.
    if (next) next();
    else running -= 1;
  }

  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}
