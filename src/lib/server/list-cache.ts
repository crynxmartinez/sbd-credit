import "server-only";
import { createHash } from "node:crypto";

/**
 * A short-lived cache of the customer list, already turned into JSON.
 *
 * Computing the list reads every ledger row and recomputes aging for every customer, in Node, on the one event loop. Every open
 * tab asks every 30 seconds, so the cost used to grow with customers x users. Here it grows with customers x writes: the
 * answer is kept until something is WRITTEN (every write goes through transaction(), which calls `bump()` once it commits) or a
 * few seconds pass (which covers a write made by another server, which this one cannot see), and a crowd asking at once is
 * answered by ONE computation.
 *
 * The cache holds the serialized string, not objects, so a hit costs no mapping and no JSON.stringify, and it yields an ETag
 * that depends only on the content (so it stays valid across restarts and servers), letting the browser skip the download.
 */
export interface ListEntry {
  body: string;
  etag: string;
}

interface Stored extends ListEntry {
  revision: number;
  at: number;
}

export interface ListCache {
  /** Something was written: whatever was computed before may be out of date. */
  bump(): void;
  get(key: string, compute: () => Promise<string>): Promise<ListEntry>;
  size(): number;
}

const MAX_KEYS = 3;

export function createListCache({ ttlMs = 10_000, now = Date.now }: { ttlMs?: number; now?: () => number } = {}): ListCache {
  let revision = 0;
  const entries = new Map<string, Stored>();
  const inflight = new Map<string, { revision: number; promise: Promise<Stored> }>();

  return {
    bump() {
      revision += 1;
    },
    async get(key, compute) {
      const hit = entries.get(key);
      if (hit && hit.revision === revision && now() - hit.at < ttlMs) return hit;

      const running = inflight.get(key);
      if (running && running.revision === revision) return running.promise;

      const startedAt = revision;
      const promise = compute().then((body): Stored => {
        const stored: Stored = { body, etag: `W/"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`, revision: startedAt, at: now() };
        // A write that committed while this was being computed may not be in it: give it to the readers that asked, but do not keep it.
        if (startedAt === revision) {
          entries.set(key, stored);
          while (entries.size > MAX_KEYS) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined) break;
            entries.delete(oldest);
          }
        }
        return stored;
      });
      inflight.set(key, { revision: startedAt, promise });
      try {
        return await promise;
      } finally {
        if (inflight.get(key)?.promise === promise) inflight.delete(key);
      }
    },
    size: () => entries.size,
  };
}

/** The one cache the app uses. */
export const customerListCache: ListCache = createListCache();
