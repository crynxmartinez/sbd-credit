/**
 * What a rule the DATABASE enforces looks like when it refuses a write: a trigger's own words, a CHECK or unique constraint,
 * or the driver's wrapper around them. An integration test that expects a refusal asserts THIS, so a typo in the test's own
 * data (a missing field, a wrong type) can no longer pass for the rule doing its job.
 */
export const DB_REFUSAL = /append-only|cannot|can only|must|not allowed|belong|violates|constraint|Unique|Foreign key|Raw query failed|check/i;
