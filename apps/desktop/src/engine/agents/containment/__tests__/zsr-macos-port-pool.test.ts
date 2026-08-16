import { describe, expect, it } from "vitest";

import { reserveMacosPortPool } from "../zsr-macos-port-pool";

describe("ZSR macOS bind-port pool", () => {
  it("reserves sorted unique ports without engine or service collisions", () => {
    let value = 0;
    const first = reserveMacosPortPool({
      size: 8,
      excludedPorts: [30_000, 30_002, 51_731],
      randomUInt32: () => value++,
    });
    const second = reserveMacosPortPool({
      size: 8,
      excludedPorts: [30_000, 30_002, 51_731],
      randomUInt32: () => value++,
    });
    try {
      expect(first.ports).toHaveLength(8);
      expect(first.ports).toEqual([...first.ports].sort((a, b) => a - b));
      expect(new Set(first.ports).size).toBe(first.ports.length);
      expect(first.ports).not.toContain(30_000);
      expect(first.ports).not.toContain(30_002);
      expect(first.ports).not.toContain(51_731);
      expect(second.ports.some((port) => first.ports.includes(port))).toBe(false);
    } finally {
      first.release();
      second.release();
    }
  });

  it("releases the process-wide reservation idempotently", () => {
    const randomUInt32 = () => 17;
    const first = reserveMacosPortPool({
      size: 1,
      excludedPorts: [],
      randomUInt32,
    });
    const port = first.ports[0];
    const second = reserveMacosPortPool({
      size: 1,
      excludedPorts: [],
      randomUInt32,
    });
    expect(second.ports[0]).not.toBe(port);
    first.release();
    first.release();
    const reused = reserveMacosPortPool({
      size: 1,
      excludedPorts: [],
      randomUInt32,
    });
    try {
      expect(reused.ports).toEqual([port]);
    } finally {
      second.release();
      reused.release();
    }
  });

  it("fails closed when the requested pool cannot be allocated", () => {
    expect(() =>
      reserveMacosPortPool({
        size: 65_536,
        excludedPorts: [],
        randomUInt32: () => 0,
      }),
    ).toThrow(/invalid macOS bind-port pool size/);
  });
});
