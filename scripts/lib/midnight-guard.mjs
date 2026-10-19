/**
 * Tests that freeze "today" (and the dates they put on entries) fail if the run crosses midnight in the zone the books are kept in:
 * the app's business day rolls over in the middle of the suite. Rather than a mysterious red run once a day, a run that would start
 * within a few minutes of midnight waits for it to pass.
 */
const DAY_SECONDS = 86_400;
export const DEFAULT_WINDOW_MS = 10 * 60_000;

/** Milliseconds from `now` until the next midnight in `timeZone` (within a minute on the two days a year the clocks change). */
export function msUntilBusinessMidnight(now = new Date(), timeZone = process.env.BUSINESS_TIME_ZONE ?? "America/Chicago") {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(now);
  const part = (type) => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  const secondsIntoDay = part("hour") * 3600 + part("minute") * 60 + part("second");
  return (DAY_SECONDS - secondsIntoDay) * 1000 - now.getMilliseconds();
}

/** True when a run starting at `now` could see the business day change before it ends. */
export function isTooCloseToMidnight(now = new Date(), windowMs = DEFAULT_WINDOW_MS, timeZone) {
  return msUntilBusinessMidnight(now, timeZone) <= windowMs;
}

/** Waits out the window just before midnight, saying so; returns at once any other time. */
export async function waitPastMidnightIfNear(label, windowMs = DEFAULT_WINDOW_MS) {
  const remaining = msUntilBusinessMidnight();
  if (remaining > windowMs) return;
  const waitMs = remaining + 5_000;
  console.log(`[${label}] midnight (${process.env.BUSINESS_TIME_ZONE ?? "America/Chicago"}) is ${Math.ceil(remaining / 1000)}s away; waiting for it to pass so the business day cannot change mid-run.`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}
