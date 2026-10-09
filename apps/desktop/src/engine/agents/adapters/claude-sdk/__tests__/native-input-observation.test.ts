import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import * as contained from "../contained-process";

function fixture() {
  const input = new Writable();
  const write = vi.fn((_chunk: unknown, _encoding?: unknown, _callback?: unknown) => false);
  input.write = write as typeof input.write;
  const observer = vi.fn();
  return { input, write, observer, uuid: randomUUID() };
}

describe("Claude actual input-write observation", () => {
  it("observes the correlated native user UUID only after the underlying write returned", () => {
    const f = fixture(), order: string[] = [];
    f.write.mockImplementation(() => { order.push("write"); return false; });
    contained.observeClaudeUserMessageWrites(f.input, uuid => { order.push("observed"); f.observer(uuid); });
    const callback = vi.fn(), frame = JSON.stringify({ type: "user", uuid: f.uuid, message: { role: "user", content: "Synthetic prompt" } }) + "\n";
    expect(f.input.write(frame, "utf8", callback)).toBe(false);
    expect(f.write).toHaveBeenCalledWith(frame, "utf8", callback);
    expect(order).toEqual(["write", "observed"]); expect(f.observer).toHaveBeenCalledWith(f.uuid);
  });
  it("does not observe a failed write", () => {
    const f = fixture(); f.write.mockImplementation(() => { throw new Error("synthetic write refusal"); });
    contained.observeClaudeUserMessageWrites(f.input, f.observer);
    expect(() => f.input.write(JSON.stringify({ type: "user", uuid: f.uuid }) + "\n")).toThrow();
    expect(f.observer).not.toHaveBeenCalled();
  });
  it("keeps control frames, malformed JSON and oversized observation frames inert", () => {
    const f = fixture(); contained.observeClaudeUserMessageWrites(f.input, f.observer);
    for (const frame of [JSON.stringify({ type: "control_request", uuid: f.uuid }), "invalid", JSON.stringify({ type: "user", uuid: "not-a-native-uuid" }),
      JSON.stringify({ type: "user", uuid: f.uuid, message: { content: "x".repeat(2 * 1024 * 1024) } })])
      f.input.write(frame + "\n");
    expect(f.write).toHaveBeenCalledTimes(4); expect(f.observer).not.toHaveBeenCalled();
  });
  it("leaves inactive observers inert and contains observer exceptions", () => {
    const f = fixture(); let active = false;
    contained.observeClaudeUserMessageWrites(f.input, () => { f.observer(); throw new Error("synthetic observer refusal"); }, () => active);
    const frame = Buffer.from(JSON.stringify({ type: "user", uuid: f.uuid }) + "\n");
    expect(() => f.input.write(frame)).not.toThrow(); expect(f.observer).not.toHaveBeenCalled();
    active = true; expect(() => f.input.write(frame)).not.toThrow(); expect(f.observer).toHaveBeenCalledOnce();
    expect(f.write).toHaveBeenCalledTimes(2);
  });
  it("contains rejected async input observers without awaiting the underlying write", async () => {
    const f = fixture(), unhandled: unknown[] = [], capture = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", capture);
    contained.observeClaudeUserMessageWrites(f.input, async () => { throw new Error("synthetic observer rejection"); });
    try {
      expect(f.input.write(JSON.stringify({ type: "user", uuid: f.uuid }) + "\n")).toBe(false);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]); expect(f.write).toHaveBeenCalledOnce();
    } finally { process.off("unhandledRejection", capture); }
  });
});
