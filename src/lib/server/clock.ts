import { businessToday } from "./as-of";

/**
 * "Now" and "today" as the business sees them, in one object a service can be handed. Services default to the real clock;
 * a test passes its own, so nothing that depends on the day has to be run at the right time to be tested.
 */
export interface Clock {
  now(): Date;
  /** The business day (YYYY-MM-DD), in the books' time zone. */
  today(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  today: () => businessToday(),
};
