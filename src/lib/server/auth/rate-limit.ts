/**
 * A small in-memory sliding-window limiter, keyed by something like a client address.
 *
 * It protects each running server process on its own. That is enough to blunt a guessing run against one instance;
 * it is not a substitute for a shared limiter if the app is ever scaled across many instances.
 */
interface Options {
  /** Hits allowed per key within the window. */
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Most keys remembered at once, so a flood of distinct addresses cannot grow memory without bound. */
  maxKeys?: number;
}

export interface RateLimiter {
  /** Records a hit and returns whether it is allowed. */
  take(key: string): boolean;
  size(): number;
}

const DEFAULT_MAX_KEYS = 10_000;

export function createRateLimiter({ limit, windowMs, now = Date.now, maxKeys = DEFAULT_MAX_KEYS }: Options): RateLimiter {
  const hits = new Map<string, number[]>();

  function pruneExpired(at: number): void {
    for (const [key, times] of hits) {
      if (times.every((time) => time <= at - windowMs)) hits.delete(key);
    }
  }

  return {
    take(key) {
      const at = now();
      const recent = (hits.get(key) ?? []).filter((time) => time > at - windowMs);

      if (!hits.has(key) && hits.size >= maxKeys) {
        pruneExpired(at);
        // Still full of live keys: drop the oldest rather than refuse to track new ones.
        if (hits.size >= maxKeys) {
          const oldest = hits.keys().next().value;
          if (oldest !== undefined) hits.delete(oldest);
        }
      }

      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      hits.set(key, [...recent, at]);
      return true;
    },
    size: () => hits.size,
  };
}
