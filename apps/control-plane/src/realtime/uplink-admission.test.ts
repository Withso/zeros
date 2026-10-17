import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import { UplinkAdmission, uplinkSourceAddress } from "./uplink-admission.js";

const request = (headers: Record<string, string>, remoteAddress = "10.0.0.9") =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

describe("uplink admission", () => {
  it("keys sources like the HTTP pre-auth limits and collapses garbage into one bucket", () => {
    expect(uplinkSourceAddress(request({ "x-real-ip": "203.0.113.5", "cf-connecting-ip": "198.51.100.1" }))).toBe("203.0.113.5");
    expect(uplinkSourceAddress(request({ "cf-connecting-ip": "198.51.100.1" }))).toBe("198.51.100.1");
    expect(uplinkSourceAddress(request({ "x-real-ip": "not an ip" }))).toBe("10.0.0.9");
    expect(uplinkSourceAddress(request({}, "garbage"))).toBe("unknown");
  });

  it("refills per source, holds unadmitted sockets per source and bounds tracked sources", () => {
    let now = 0;
    const admission = new UplinkAdmission({ globalBurst: 100, globalRefillMs: 1, sourceBurst: 2, sourcePerSecond: 1,
      sourceMaxUnadmitted: 3, maxSources: 2 }, () => now);
    const first = admission.admit("a"), second = admission.admit("a");
    expect(admission.admit("a")).toBe("rate_limited");
    now += 1_000;
    const third = admission.admit("a");
    now += 1_000;
    expect(admission.admit("a")).toBe("capacity");
    for (const ticket of [first, second, third]) if (typeof ticket === "object") ticket.release();
    expect(typeof admission.admit("a")).toBe("object");
    // Past the bound with every source busy, new sources share one bucket.
    expect(typeof admission.admit("b")).toBe("object");
    expect(typeof admission.admit("c")).toBe("object");
    expect(typeof admission.admit("d")).toBe("object");
    expect(admission.admit("e")).toBe("rate_limited");
  });
});
