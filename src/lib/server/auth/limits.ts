/**
 * A limit from the environment. Outside production a positive whole number overrides the default (the automated tests
 * sign in far more often than a person would). In PRODUCTION the override is ignored, so a setting left over from testing
 * cannot quietly switch a sign-in limit off. The startup check also refuses such settings in production.
 */
export function attemptLimit(value: string | undefined, fallback: number, production: boolean): number {
  if (production) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
