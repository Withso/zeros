import { describe, expect, it, vi } from "vitest";
import type { SimulatorFrame } from "@zeros/protocol/simulators";

import { LatestFramePainter, type DecodedFrame } from "../simulator-frame-painter";

function frame(seq: number): SimulatorFrame {
  return { viewId: "view-1", seq, width: 4, height: 8, jpeg: new Uint8Array([seq]) };
}

function decoder() {
  const waiting = new Map<number, (image: DecodedFrame) => void>();
  const failing = new Map<number, (error: unknown) => void>();
  const closed: number[] = [];
  const decode = vi.fn(
    (value: SimulatorFrame) =>
      new Promise<DecodedFrame>((resolve, reject) => {
        waiting.set(value.seq, resolve);
        failing.set(value.seq, reject);
      }),
  );
  const finish = async (seq: number) => {
    waiting.get(seq)?.({ width: 4, height: 8, close: () => closed.push(seq) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const fail = async (seq: number) => {
    failing.get(seq)?.(new Error("bad jpeg"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { decode, finish, fail, closed };
}

describe("LatestFramePainter", () => {
  it("skips frames that arrive during a decode, keeping only the newest", async () => {
    const { decode, finish, closed } = decoder();
    const paint = vi.fn();
    const painter = new LatestFramePainter(decode, paint);
    painter.push(frame(1));
    painter.push(frame(2));
    painter.push(frame(4));
    painter.push(frame(3));
    expect(decode).toHaveBeenCalledTimes(1);

    await finish(1);
    expect(paint.mock.calls.map(([, value]) => value.seq)).toEqual([1]);
    expect(decode.mock.calls.map(([value]) => value.seq)).toEqual([1, 4]);
    await finish(4);
    expect(paint.mock.calls.map(([, value]) => value.seq)).toEqual([1, 4]);
    expect(closed).toEqual([1, 4]);

    painter.push(frame(2));
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("moves past a frame that won't decode and paints nothing after disposal", async () => {
    const { decode, finish, fail, closed } = decoder();
    const paint = vi.fn();
    const painter = new LatestFramePainter(decode, paint);
    painter.push(frame(1));
    painter.push(frame(2));
    await fail(1);
    expect(decode).toHaveBeenCalledTimes(2);
    painter.dispose();
    await finish(2);
    expect(paint).not.toHaveBeenCalled();
    expect(closed).toEqual([2]);
  });
});
