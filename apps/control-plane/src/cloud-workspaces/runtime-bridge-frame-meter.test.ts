import { describe, expect, it } from "vitest";
import { WebSocketFrameMeter } from "./runtime-bridge-frame-meter.js";

function header(
  opcode: number,
  length: number,
  options: { final?: boolean; masked?: boolean } = {},
): Buffer {
  const extended = length < 126 ? 0 : length < 65_536 ? 2 : 8;
  const masked = options.masked ?? false;
  const bytes = Buffer.alloc(2 + extended + (masked ? 4 : 0));
  bytes[0] = (options.final === false ? 0 : 0x80) | opcode;
  bytes[1] =
    (masked ? 0x80 : 0) |
    (extended === 0 ? length : extended === 2 ? 126 : 127);
  if (extended === 2) bytes.writeUInt16BE(length, 2);
  if (extended === 8) bytes.writeBigUInt64BE(BigInt(length), 2);
  if (masked) bytes.set([0x12, 0x34, 0x56, 0x78], bytes.length - 4);
  return bytes;
}

function frame(
  opcode: number,
  length: number,
  options: { final?: boolean; masked?: boolean } = {},
): Buffer {
  return Buffer.concat([
    header(opcode, length, options),
    Buffer.alloc(length, 7),
  ]);
}

function record(events: string[]) {
  return new WebSocketFrameMeter({
    grow: (bytes) => {
      events.push(`grow ${bytes}`);
      return true;
    },
    complete: () => events.push("complete"),
  });
}

function next(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

describe("websocket frame meter", () => {
  it("reports each data frame's cumulative declared size and the message end", () => {
    const events: string[] = [];
    const meter = record(events);
    meter.feed(
      Buffer.concat([
        frame(1, 5),
        frame(2, 300, { masked: true }),
        frame(1, 70_000),
        frame(2, 0),
      ]),
    );
    expect(events).toEqual([
      "grow 5",
      "complete",
      "grow 300",
      "complete",
      "grow 70000",
      "complete",
      "grow 0",
      "complete",
    ]);
  });

  it("charges a 64-bit length at the header, before any payload arrives", () => {
    const events: string[] = [];
    const meter = record(events);
    meter.feed(header(2, 64 * 1024 * 1024, { masked: true }));
    expect(events).toEqual([`grow ${64 * 1024 * 1024}`]);
    meter.feed(Buffer.alloc(1024));
    expect(events).toHaveLength(1);
  });

  it("follows fragmented messages across interleaved control frames", () => {
    const events: string[] = [];
    const meter = record(events);
    meter.feed(
      Buffer.concat([
        frame(1, 100, { final: false }),
        frame(9, 4),
        frame(0, 200, { final: false }),
        frame(10, 0),
        frame(0, 300),
        frame(9, 125),
      ]),
    );
    expect(events).toEqual(["grow 100", "grow 300", "grow 600", "complete"]);
  });

  it("is independent of how the stream is chunked", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = next(seed);
      const parts: Buffer[] = [];
      const expected: string[] = [];
      for (let message = 0; message < 30; message++) {
        const fragments = 1 + Math.floor(random() * 3);
        let total = 0;
        for (let fragment = 0; fragment < fragments; fragment++) {
          const roll = random();
          const length =
            roll < 0.4
              ? Math.floor(random() * 126)
              : roll < 0.8
                ? 126 + Math.floor(random() * 70_000)
                : 65_536 + Math.floor(random() * 200_000);
          total += length;
          const masked = seed % 2 === 0;
          parts.push(
            frame(fragment === 0 ? 1 + (message % 2) : 0, length, {
              final: fragment === fragments - 1,
              masked,
            }),
          );
          expected.push(`grow ${total}`);
          if (random() < 0.3)
            parts.push(frame(9, Math.floor(random() * 126), { masked }));
        }
        expected.push("complete");
      }
      const stream = Buffer.concat(parts);
      const events: string[] = [];
      const meter = record(events);
      for (let offset = 0; offset < stream.length; ) {
        const size = random() < 0.2 ? 1 : 1 + Math.floor(random() * 9_000);
        meter.feed(stream.subarray(offset, offset + size));
        offset += size;
      }
      expect(events, `seed ${seed}`).toEqual(expected);
    }
  });

  it("stops metering once the budget refuses a message", () => {
    const events: string[] = [];
    const meter = new WebSocketFrameMeter({
      grow: (bytes) => {
        events.push(`grow ${bytes}`);
        return bytes < 1_000;
      },
      complete: () => events.push("complete"),
    });
    meter.feed(Buffer.concat([frame(2, 10), frame(2, 5_000), frame(2, 10)]));
    meter.feed(frame(2, 10));
    expect(events).toEqual(["grow 10", "complete", "grow 5000"]);
  });

  it("stops on a length no WebSocket peer may declare", () => {
    const events: string[] = [];
    const meter = record(events);
    const invalid = header(2, 0);
    const oversized = Buffer.alloc(10);
    oversized[0] = 0x82;
    oversized[1] = 127;
    oversized.writeBigUInt64BE(2n ** 63n, 2);
    meter.feed(Buffer.concat([invalid, oversized, frame(2, 10)]));
    expect(events).toEqual(["grow 0", "complete"]);
  });
});
