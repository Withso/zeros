import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  createSharedBackpressureGate,
  type BackpressureSink,
} from "../stream-backpressure";

class FakeSink extends EventEmitter implements BackpressureSink {
  constructor(private readonly acceptsWrite: boolean) {
    super();
  }

  write = vi.fn((_chunk: string | Buffer) => this.acceptsWrite);
}

describe("createSharedBackpressureGate", () => {
  it("pauses every source until a saturated sink drains", () => {
    const sources = [
      { pause: vi.fn(), resume: vi.fn() },
      { pause: vi.fn(), resume: vi.fn() },
    ];
    const sink = new FakeSink(false);
    const gate = createSharedBackpressureGate(sources);

    gate.write(sink, "burst");

    for (const source of sources) {
      expect(source.pause).toHaveBeenCalledTimes(1);
      expect(source.resume).not.toHaveBeenCalled();
    }

    sink.emit("drain");

    for (const source of sources) {
      expect(source.resume).toHaveBeenCalledTimes(1);
    }
  });

  it("does not pause sources while the sink accepts writes", () => {
    const source = { pause: vi.fn(), resume: vi.fn() };
    const gate = createSharedBackpressureGate([source]);

    gate.write(new FakeSink(true), "normal");

    expect(source.pause).not.toHaveBeenCalled();
    expect(source.resume).not.toHaveBeenCalled();
  });

  it("waits for every saturated rotating generation before resuming", () => {
    const source = { pause: vi.fn(), resume: vi.fn() };
    const first = new FakeSink(false);
    const second = new FakeSink(false);
    const gate = createSharedBackpressureGate([source]);

    gate.write(first, "old generation");
    gate.write(second, "new generation");
    expect(source.pause).toHaveBeenCalledTimes(1);

    first.emit("drain");
    expect(source.resume).not.toHaveBeenCalled();

    // An ended rotating stream may close without a drain notification.
    second.emit("close");
    expect(source.resume).toHaveBeenCalledTimes(1);
  });
});
