import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import * as contained from "../contained-process";
function fixture() {
  const input = new Writable();
  const write = vi.fn((_chunk: unknown, _encoding?: unknown, _callback?: unknown) => false);
  input.write = write as typeof input.write;
  const guard = vi.fn((_uuid: string) => {});
  const uuid = randomUUID(), frame = JSON.stringify({ type: "user", uuid, message: { role: "user", content: "Synthetic prompt" } }) + "\n";
  return { input, write, guard, uuid, frame };
}
describe("Claude boot authority at the irreversible input write", () => {
  it("guards and conservatively marks before a complete SDK user frame is written", () => {
    const f = fixture(), order: string[] = [], callback = vi.fn();
    f.guard.mockImplementation(() => { order.push("handoff"); });
    f.write.mockImplementation(() => { order.push("write"); return false; });
    contained.guardClaudeUserMessageWrites(f.input, f.guard);
    expect(f.input.write(f.frame, "utf8", callback)).toBe(false);
    expect(order).toEqual(["handoff", "write"]);
    expect(f.guard).toHaveBeenCalledWith(f.uuid);
    expect(f.write).toHaveBeenCalledWith(f.frame, "utf8", callback);
  });
  it("propagates the exact closed authority failure without entering the underlying transport", () => {
    const f = fixture(), error = Object.assign(new Error("Cloud authority unavailable"), { code: "cloud_agent_credential_revoked" });
    f.guard.mockImplementation(() => { throw error; });
    contained.guardClaudeUserMessageWrites(f.input, f.guard);
    expect(() => f.input.write(f.frame)).toThrow(error);
    expect(f.write).not.toHaveBeenCalled();
  });
  it("keeps a possibly-executed mark after an underlying write throws", () => {
    const f = fixture(); let entered = false;
    f.guard.mockImplementation(() => { entered = true; });
    f.write.mockImplementation(() => { throw new Error("Synthetic transport refusal"); });
    contained.guardClaudeUserMessageWrites(f.input, f.guard);
    expect(() => f.input.write(f.frame)).toThrow("Synthetic transport refusal");
    expect(entered).toBe(true);
  });
  it("keeps SDK control replies outside new foreground authority", () => {
    const f = fixture(); contained.guardClaudeUserMessageWrites(f.input, f.guard);
    const frame = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "test-control" } }) + "\n";
    expect(f.input.write(frame)).toBe(false);
    expect(f.guard).not.toHaveBeenCalled(); expect(f.write).toHaveBeenCalledWith(frame);
  });
  it.each(["invalid JSON", "missing newline", "multiple frames", "missing UUID", "invalid UUID", "non-UTF8 encoding"])(
    "rejects %s before any possibly-unowned prompt bytes enter the process", kind => {
      const f = fixture(); contained.guardClaudeUserMessageWrites(f.input, f.guard);
      const frame = kind === "invalid JSON" ? "invalid\n" : kind === "missing newline" ? f.frame.slice(0, -1) :
        kind === "multiple frames" ? f.frame + f.frame : kind === "missing UUID" ? JSON.stringify({ type: "user" }) + "\n" :
          kind === "invalid UUID" ? JSON.stringify({ type: "user", uuid: "unowned" }) + "\n" : f.frame;
      expect(() => f.input.write(frame, kind === "non-UTF8 encoding" ? "base64" : "utf8"))
        .toThrow(expect.objectContaining({ code: "cloud_validation_access_denied" }));
      expect(f.guard).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    });
  it("admits a bounded image-bearing frame larger than the passive observer bound", () => {
    const f = fixture(); contained.guardClaudeUserMessageWrites(f.input, f.guard);
    const frame = Buffer.from(JSON.stringify({ type: "user", uuid: f.uuid, message: { role: "user",
      content: [{ type: "image", source: { type: "base64", data: "x".repeat(7 * 1024 * 1024) } }] } }) + "\n");
    expect(f.input.write(frame)).toBe(false); expect(f.guard).toHaveBeenCalledWith(f.uuid);
  });
  it("refuses an asynchronous authority callback and contains its rejected promise", async () => {
    const f = fixture(), unhandled: unknown[] = [], capture = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", capture);
    try {
      contained.guardClaudeUserMessageWrites(f.input, async () => { throw new Error("Synthetic async authority"); });
      expect(() => f.input.write(f.frame)).toThrow(expect.objectContaining({ code: "cloud_validation_access_denied" }));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.write).not.toHaveBeenCalled(); expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", capture); }
  });
});
