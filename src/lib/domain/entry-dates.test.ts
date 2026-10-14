import { describe, expect, test } from "vitest";
import { MAX_POSTDATE_DAYS } from "./constants";
import { entryDateIssue, entryDateProblem, entryDateWindow } from "./entry-dates";

const TODAY = "2026-10-13";

describe("entryDateWindow", () => {
  test("an employee may date an entry from the first of this month; an admin may go further back", () => {
    expect(entryDateWindow("EMPLOYEE", TODAY).min).toBe("2026-10-01");
    expect(entryDateWindow("ADMIN", TODAY).min).toBeNull();
    expect(entryDateWindow("SUPERADMIN", TODAY).min).toBeNull();
  });

  test("nobody may date an entry more than the limit ahead", () => {
    expect(entryDateWindow("ADMIN", TODAY).max).toBe("2027-01-11"); // 90 days on from Oct 13
    expect(MAX_POSTDATE_DAYS).toBe(90);
  });
});

describe("entryDateProblem", () => {
  test("accepts today, this month and a reasonable future date", () => {
    expect(entryDateProblem("EMPLOYEE", TODAY, TODAY)).toBeNull();
    expect(entryDateProblem("EMPLOYEE", "2026-10-01", TODAY)).toBeNull();
    expect(entryDateProblem("EMPLOYEE", "2026-12-01", TODAY)).toBeNull();
  });

  test("an employee cannot post into a closed month, an admin can", () => {
    expect(entryDateProblem("EMPLOYEE", "2026-09-30", TODAY)).toMatch(/already closed/);
    expect(entryDateProblem("ADMIN", "2026-09-30", TODAY)).toBeNull();
    expect(entryDateProblem("ADMIN", "2024-01-01", TODAY)).toBeNull();
  });

  test("nobody can date an entry far in the future: a typo year would hide it for years", () => {
    expect(entryDateProblem("ADMIN", "2027-01-12", TODAY)).toMatch(/more than 90 days/);
    expect(entryDateProblem("ADMIN", "2099-01-01", TODAY)).toMatch(/more than 90 days/);
    expect(entryDateProblem("ADMIN", "2027-01-11", TODAY)).toBeNull(); // exactly at the limit
  });
});

describe("entryDateIssue", () => {
  test("says WHICH rule was broken, so a service can answer with the right kind of refusal", () => {
    expect(entryDateIssue("ADMIN", "2099-01-01", TODAY)?.code).toBe("too_far_ahead");
    expect(entryDateIssue("EMPLOYEE", "2026-09-30", TODAY)?.code).toBe("closed_month");
    expect(entryDateIssue("ADMIN", "2026-09-30", TODAY)).toBeNull();
    expect(entryDateIssue("EMPLOYEE", TODAY, TODAY)).toBeNull();
  });
});
