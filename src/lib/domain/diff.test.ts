import { describe, expect, test } from "vitest";
import { diffFields, summarizeChanges } from "./diff";

const labels = { businessName: "Business name", creditLimitCents: "Credit limit", phone: "Phone" };

describe("diffFields", () => {
  test("returns only the tracked fields that changed", () => {
    const changes = diffFields(
      { businessName: "Acme", creditLimitCents: 100, phone: "555", ignored: "a" },
      { businessName: "Acme Co", creditLimitCents: 100, phone: "555", ignored: "b" },
      labels,
    );
    expect(changes).toEqual([{ field: "businessName", label: "Business name", from: "Acme", to: "Acme Co" }]);
  });

  test("treats missing and null as the same", () => {
    expect(diffFields({ phone: null }, {}, labels)).toEqual([]);
  });

  test("reports a value being cleared or set", () => {
    expect(diffFields({ phone: "555" }, { phone: null }, labels)).toHaveLength(1);
    expect(diffFields({}, { phone: "555" }, labels)).toHaveLength(1);
  });
});

describe("summarizeChanges", () => {
  test("names what changed", () => {
    const changes = diffFields({ businessName: "A", phone: "1" }, { businessName: "B", phone: "2" }, labels);
    expect(summarizeChanges(changes)).toBe("Updated business name, phone");
  });

  test("says so when nothing changed", () => {
    expect(summarizeChanges([])).toBe("Saved with no changes");
  });
});
