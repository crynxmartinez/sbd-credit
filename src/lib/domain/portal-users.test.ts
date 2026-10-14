import { describe, expect, test } from "vitest";
import { INVITE_TTL_MS, RESET_TTL_MS, canInviteTo, inviteStatus, normalizeEmail, validateContact } from "./portal-users";

describe("normalizeEmail", () => {
  test("trims and lower-cases, so the same address is always the same account", () => {
    expect(normalizeEmail("  Dana.Whitfield@MidwestFab.Example ")).toBe("dana.whitfield@midwestfab.example");
  });
});

describe("validateContact", () => {
  test("accepts a name and a real email", () => {
    expect(validateContact({ name: "Dana Whitfield", email: "dana@midwestfab.example" })).toEqual([]);
  });

  test("refuses a missing name, a bad email, and an over-long value", () => {
    expect(validateContact({ name: "  ", email: "dana@midwestfab.example" })).toHaveLength(1);
    expect(validateContact({ name: "Dana", email: "not-an-email" })).toHaveLength(1);
    expect(validateContact({ name: "x".repeat(121), email: "dana@midwestfab.example" })).toHaveLength(1);
    expect(validateContact({ name: "Dana", email: `${"a".repeat(250)}@example.com` })).toHaveLength(1);
  });

  test("an email may not look like a staff username (no '@'-free values), so the two kinds of sign-in never collide", () => {
    expect(validateContact({ name: "Dana", email: "dana" })).toHaveLength(1);
  });
});

describe("canInviteTo", () => {
  test("only customers who have, or had, credit can be given portal access", () => {
    expect(canInviteTo("approved")).toBe(true);
    expect(canInviteTo("suspended")).toBe(true);
    for (const status of ["submitted", "under_review", "denied"] as const) expect(canInviteTo(status)).toBe(false);
  });
});

describe("invites", () => {
  test("a first invitation lasts seven days; a reset for someone who already has a password, two", () => {
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(RESET_TTL_MS).toBe(2 * 24 * 60 * 60 * 1000);
  });

  test("a contact is shown as Invited, Active or Disabled", () => {
    expect(inviteStatus({ active: true, hasPassword: false })).toBe("invited");
    expect(inviteStatus({ active: true, hasPassword: true })).toBe("active");
    expect(inviteStatus({ active: false, hasPassword: true })).toBe("disabled");
    expect(inviteStatus({ active: false, hasPassword: false })).toBe("disabled");
  });
});
