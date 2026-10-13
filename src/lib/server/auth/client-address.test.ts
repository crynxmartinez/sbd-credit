import { describe, expect, test } from "vitest";
import { clientAddress, trustedHopsFromEnv } from "./client-address";

const headers = (forwarded?: string) => ({ get: (name: string) => (name === "x-forwarded-for" && forwarded ? forwarded : null) });

describe("clientAddress", () => {
  test("uses the address our own proxy appended, which is the LAST entry behind one proxy", () => {
    expect(clientAddress(headers("203.0.113.9"))).toBe("203.0.113.9");
    expect(clientAddress(headers("198.51.100.1, 203.0.113.9"), 1)).toBe("203.0.113.9");
  });

  test("a client cannot pick its own address by forging the front of the list", () => {
    // The attacker sent "1.1.1.1"; the proxy appended the real address.
    expect(clientAddress(headers("1.1.1.1, 203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(clientAddress(headers("1.1.1.1, 2.2.2.2, 203.0.113.9"), 1)).toBe("203.0.113.9");
  });

  test("counts back through several trusted proxies", () => {
    expect(clientAddress(headers("203.0.113.9, 10.0.0.2, 10.0.0.1"), 3)).toBe("203.0.113.9");
    expect(clientAddress(headers("only-one"), 3)).toBe("only-one");
  });

  test("ignores the header entirely when there is no proxy to trust", () => {
    expect(clientAddress(headers("1.1.1.1"), 0)).toBe("local");
  });

  test("falls back to a shared bucket when there is no header", () => {
    expect(clientAddress(headers())).toBe("local");
  });

  test("tolerates stray spaces and empty entries", () => {
    expect(clientAddress(headers(" , 203.0.113.9 ,"), 1)).toBe("203.0.113.9");
  });
});

describe("trustedHopsFromEnv", () => {
  test.each([
    [undefined, 1],
    ["1", 1],
    ["0", 0],
    ["2", 2],
    ["-1", 1],
    ["abc", 1],
    ["2.5", 1],
    ["99", 1],
  ])("%j gives %i", (value, expected) => {
    expect(trustedHopsFromEnv(value)).toBe(expected);
  });
});
