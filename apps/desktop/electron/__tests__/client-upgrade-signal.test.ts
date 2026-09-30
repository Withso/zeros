import { describe, expect, it, vi } from "vitest";

describe("client upgrade signal", () => {
  it("delivers answers that arrive before the updater registers, then forwards live", async () => {
    vi.resetModules();
    const signal = await import("../client-upgrade-signal");
    signal.signalClientUpgrade({ n: 1 });
    signal.signalClientUpgrade({ n: 2 });
    const handler = vi.fn();
    signal.onClientUpgrade(handler);
    expect(handler.mock.calls.map(([value]) => value)).toEqual([{ n: 1 }, { n: 2 }]);
    signal.signalClientUpgrade({ n: 3 });
    expect(handler).toHaveBeenLastCalledWith({ n: 3 });
  });

  it("keeps a bounded backlog and survives an invalid early answer", async () => {
    vi.resetModules();
    const signal = await import("../client-upgrade-signal");
    for (let n = 0; n < 12; n += 1) signal.signalClientUpgrade({ n });
    const seen: number[] = [];
    signal.onClientUpgrade((value) => {
      const n = (value as { n: number }).n;
      if (n === 5) throw new Error("invalid");
      seen.push(n);
    });
    expect(seen).toEqual([4, 6, 7, 8, 9, 10, 11]);
  });
});
