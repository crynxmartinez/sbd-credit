import { describe, expect, test } from "vitest";
import { addressBucket, clientAddress, trustedHopsFromEnv } from "./client-address";

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

describe("clientAddress with ports", () => {
  const headers = (value: string) => ({ get: () => value });
  test("a port appended by the proxy is not part of the address, so connections from one person share a bucket", () => {
    expect(clientAddress(headers("203.0.113.9:51000"), 1)).toBe("203.0.113.9");
    expect(clientAddress(headers("203.0.113.9:52000"), 1)).toBe("203.0.113.9");
    expect(clientAddress(headers("[2001:db8::1]:443"), 1)).toBe("2001:db8::1");
    expect(clientAddress(headers("[2001:db8::1]"), 1)).toBe("2001:db8::1");
    expect(clientAddress(headers("2001:db8::1"), 1)).toBe("2001:db8::1");
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

describe("clientAddress when the number of proxies is set too high", () => {
  test("fails closed to the last entry (the one our proxy added), never to the first (which the client wrote)", () => {
    expect(clientAddress(headers("1.1.1.1, 203.0.113.9"), 4)).toBe("203.0.113.9");
    expect(clientAddress(headers("1.1.1.1"), 3)).toBe("1.1.1.1");
  });
});

describe("addressBucket", () => {
  test("an IPv4 address is its own bucket", () => {
    expect(addressBucket("203.0.113.9")).toBe("203.0.113.9");
  });

  test("every address in one IPv6 /64 shares a bucket, so one person cannot dodge a limit by rotating through billions of addresses", () => {
    expect(addressBucket("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3:8d3::/64");
    expect(addressBucket("2001:db8:85a3:8d3:ffff:ffff:ffff:ffff")).toBe("2001:db8:85a3:8d3::/64");
    expect(addressBucket("2001:DB8:85A3:8D3::1")).toBe("2001:db8:85a3:8d3::/64");
    expect(addressBucket("2001:db8:85a3:8d4::1")).not.toBe(addressBucket("2001:db8:85a3:8d3::1"));
  });

  test("handles shorthand and mapped IPv4 forms, and leaves anything else alone", () => {
    expect(addressBucket("::1")).toBe("0:0:0:0::/64");
    expect(addressBucket("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(addressBucket("local")).toBe("local");
    expect(addressBucket("not an address")).toBe("not an address");
  });
});
