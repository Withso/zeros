import { describe, expect, it } from "vitest";

import { clientAddress } from "./client-address.js";

const headers = (values: Record<string, string>) => (name: string) => values[name];

describe("client address", () => {
  it("prefers a present X-Real-IP, then CF-Connecting-IP, then the peer, and collapses anything else", () => {
    expect(clientAddress(headers({ "x-real-ip": " 203.0.113.5 ", "cf-connecting-ip": "198.51.100.1" }))).toBe("203.0.113.5");
    expect(clientAddress(headers({ "cf-connecting-ip": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientAddress(headers({}), "10.0.0.9")).toBe("10.0.0.9");
    expect(clientAddress(headers({}))).toBe("unknown");
    for (const realIp of ["", "not an ip", "203.0.113.5, 198.51.100.1"])
      expect(clientAddress(headers({ "x-real-ip": realIp, "cf-connecting-ip": "198.51.100.1" }), "10.0.0.9")).toBe("unknown");
  });
});
