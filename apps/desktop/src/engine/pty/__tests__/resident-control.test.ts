import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runResidentControl } from "../resident-control";
import type { ResidentPtyHost } from "../resident-host";

const identity = { hostId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222", workspaceId: "33333333-3333-4333-8333-333333333333" };

describe("private resident lifetime control", () => {
  function fixture() {
    const input = new PassThrough(), output = new PassThrough();
    const host = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), authorize: vi.fn(), revoke: vi.fn() };
    const create = vi.fn(() => host as unknown as ResidentPtyHost);
    let replies = ""; output.on("data", chunk => { replies += String(chunk); });
    const running = runResidentControl(input, output, create);
    const send = (value: unknown) => input.write(JSON.stringify(value) + "\n");
    return { input, host, create, running, send, replies: () => replies };
  }
  it("stops workloads when the supervisor pipe closes, but acknowledges enrollment on that pipe only", async () => {
    const f = fixture();
    f.send({ id: 1, op: "start", identity });
    f.send({ id: 2, op: "ping" });
    await vi.waitFor(() => expect(f.replies()).toContain('"id":2'));
    expect(f.host.start).toHaveBeenCalledOnce();
    f.input.end(); await f.running;
    expect(f.host.stop).toHaveBeenCalledOnce();
    expect(f.replies()).toBe('{"id":1,"ok":true}\n{"id":2,"ok":true}\n');
  });
  it("fails closed on an oversized or unrecognized root control frame", async () => {
    for (const invalid of [{ id: 2, op: "start", identity, command: "forbidden" }, "x".repeat(17000)]) {
      const f = fixture(); const rejected = expect(f.running).rejects.toThrow();
      f.send({ id: 1, op: "start", identity });
      await vi.waitFor(() => expect(f.host.start).toHaveBeenCalledOnce());
      f.send(invalid); await rejected;
      expect(f.host.stop).toHaveBeenCalledOnce();
      expect(f.create).toHaveBeenCalledOnce();
    }
  });
});
