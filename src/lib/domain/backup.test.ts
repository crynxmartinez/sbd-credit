import { describe, expect, test } from "vitest";
import { BACKUP_FORMAT, inBatches, reviveBackup } from "./backup";

function file(overrides: Record<string, unknown> = {}) {
  return {
    format: BACKUP_FORMAT,
    schema: "credit_dev",
    takenAt: "2026-10-14T00:00:00.000Z",
    counts: { customers: 1, ledger: 1, audit: 1 },
    customers: [{ id: "c1", businessName: "2026-10-13 Fabrication", notes: "2026-10-13T00:00:00.000Z", dateApplied: "2026-10-01T00:00:00.000Z", statusChangedOn: "2026-10-01T00:00:00.000Z", creditStartDate: null, createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-02T10:00:00.000Z" }],
    ledger: [{ id: "l1", customerId: "c1", entryDate: "2026-10-05T00:00:00.000Z", dueDate: null, createdAt: "2026-10-05T10:00:00.000Z", voidedAt: null }],
    audit: [{ id: "a1", customerId: "c1", ledgerEntryId: "l1", createdAt: "2026-10-05T10:00:01.000Z" }],
    users: [{ id: "u1", username: "admin", name: "Admin", role: "ADMIN", active: true }],
    ...overrides,
  };
}

describe("reviveBackup", () => {
  test("turns the named date columns back into real dates", () => {
    const revived = reviveBackup(file());
    expect(revived.customers[0]!.dateApplied).toBeInstanceOf(Date);
    expect((revived.customers[0]!.dateApplied as Date).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(revived.ledger[0]!.entryDate).toBeInstanceOf(Date);
    expect(revived.audit[0]!.createdAt).toBeInstanceOf(Date);
  });

  test("leaves empty dates empty", () => {
    const revived = reviveBackup(file());
    expect(revived.customers[0]!.creditStartDate).toBeNull();
    expect(revived.ledger[0]!.dueDate).toBeNull();
    expect(revived.ledger[0]!.voidedAt).toBeNull();
  });

  test("never mistakes free text that looks like a date for a date", () => {
    const revived = reviveBackup(file());
    expect(revived.customers[0]!.businessName).toBe("2026-10-13 Fabrication");
    expect(revived.customers[0]!.notes).toBe("2026-10-13T00:00:00.000Z");
  });

  test("does not change its input", () => {
    const input = file();
    const snapshot = JSON.stringify(input);
    reviveBackup(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test.each([
    ["not an object", "nope", /not a JSON object/],
    ["an unknown format", file({ format: 99 }), /Unsupported backup format 99/],
    ["missing tables", file({ ledger: undefined }), /missing customers, ledger or audit/],
    ["a truncated file (counts disagree)", file({ counts: { customers: 1, ledger: 5, audit: 1 } }), /incomplete.*ledger/],
    ["a ledger row with no customer", file({ ledger: [{ id: "l1", customerId: "ghost", entryDate: "2026-10-05T00:00:00.000Z" }] }), /customer that is not in the backup/],
    ["an audit row pointing at a missing entry", file({ audit: [{ id: "a1", customerId: "c1", ledgerEntryId: "ghost", createdAt: "2026-10-05T10:00:01.000Z" }] }), /ledger entry that is not in the backup/],
    ["a date that is not a date", file({ customers: [{ id: "c1", dateApplied: "yesterday", createdAt: "2026-10-01T10:00:00.000Z" }] }), /not a valid date/],
    ["a date that is a number", file({ customers: [{ id: "c1", dateApplied: 12345 }] }), /should be a date string/],
  ])("refuses %s before anything is written", (_name, input, message) => {
    expect(() => reviveBackup(input)).toThrow(message);
  });

  test("a backup with no users section still restores", () => {
    expect(reviveBackup(file({ users: undefined })).users).toEqual([]);
  });
});

describe("inBatches", () => {
  test("splits into even batches with a short last one", () => {
    expect(inBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("handles empty and exact sizes", () => {
    expect(inBatches([], 3)).toEqual([]);
    expect(inBatches([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });
});

describe("customer portal contacts in a backup", () => {
  const contact = {
    id: "p1", customerId: "c1", email: "dana@example.com", name: "Dana", active: true, sessionVersion: 4,
    lastLoginAt: "2026-10-10T10:00:00.000Z", createdBy: "Admin", createdById: "u1",
    createdAt: "2026-10-02T10:00:00.000Z", updatedAt: "2026-10-03T10:00:00.000Z",
  };
  const withContacts = (rows: unknown[] = [contact]) =>
    file({ portalContacts: rows, counts: { customers: 1, ledger: 1, audit: 1, portalContacts: rows.length } });

  test("an older backup with no portal section still restores, with no contacts", () => {
    expect(reviveBackup(file()).portalContacts).toEqual([]);
  });

  test("dates come back as dates, and a missing last sign-in stays empty", () => {
    const revived = reviveBackup(withContacts([contact, { ...contact, id: "p2", email: "x@example.com", lastLoginAt: null }]));
    expect(revived.portalContacts[0]!.lastLoginAt).toBeInstanceOf(Date);
    expect(revived.portalContacts[1]!.lastLoginAt).toBeNull();
    expect(revived.portalContacts[0]!.createdAt).toBeInstanceOf(Date);
  });

  test("the session version goes UP by one, so a cookie issued before the backup can never be accepted again", () => {
    expect(reviveBackup(withContacts()).portalContacts[0]!.sessionVersion).toBe(5);
    expect(reviveBackup(withContacts([{ ...contact, sessionVersion: undefined }])).portalContacts[0]!.sessionVersion).toBe(2);
  });

  test("a backup row can never carry a credential into a restore, whatever the file says", () => {
    const row = reviveBackup(withContacts([{ ...contact, passwordHash: "x", failedLogins: 9, lockedUntil: "2099-01-01T00:00:00.000Z" }])).portalContacts[0]!;
    expect(row).not.toHaveProperty("passwordHash");
    expect(row).not.toHaveProperty("failedLogins");
    expect(row).not.toHaveProperty("lockedUntil");
  });

  test("is refused when a contact points at a customer that is not in the backup, or the count disagrees", () => {
    expect(() => reviveBackup(withContacts([{ ...contact, customerId: "ghost" }]))).toThrow(/customer that is not in the backup/);
    expect(() => reviveBackup(file({ portalContacts: [contact], counts: { customers: 1, ledger: 1, audit: 1, portalContacts: 3 } }))).toThrow(/incomplete.*portalContacts/);
  });

  test("an email may appear only once", () => {
    expect(() => reviveBackup(withContacts([contact, { ...contact, id: "p2" }]))).toThrow(/same email/);
  });
});

describe("sign-in accounts in a backup", () => {
  const user = { id: "u1", username: "dana", name: "Dana", role: "ADMIN", active: true };

  test("are checked: an unknown role, a missing username or a repeated username is refused before anything is written", () => {
    expect(() => reviveBackup(file({ users: [{ ...user, role: "OWNER" }] }))).toThrow(/role/);
    expect(() => reviveBackup(file({ users: [{ ...user, username: "" }] }))).toThrow(/username/);
    expect(() => reviveBackup(file({ users: [user, { ...user, id: "u2" }] }))).toThrow(/same username/);
  });

  test("keep their original id, role and active flag, and never carry a credential", () => {
    const revived = reviveBackup(file({ users: [{ ...user, passwordHash: "x", failedLogins: 3 }] })).users;
    expect(revived).toEqual([user]);
  });
});
