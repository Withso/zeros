import { describe, expect, it, vi } from "vitest";
import { BoatBootstrapDialog } from "./boat-bootstrap-dialog.js";

describe("bounded bootstrap dialogue", () => {
  it("assembles chunked UTF-8 frames and serializes replies", async () => {
    const write = vi.fn();
    const fail = vi.fn();
    const seen: string[] = [];
    const dialog = new BoatBootstrapDialog(async line => { seen.push(line); return JSON.stringify({ allow: true }); }, write, fail);
    const frame = Buffer.from('{"phase":"authorize","fixture":"é"}\n');
    dialog.feed(frame.subarray(0, frame.length - 4));
    dialog.feed(Buffer.concat([frame.subarray(frame.length - 4), Buffer.from('{"phase":"enroll"}\n')]));
    await dialog.finish();
    expect(seen).toEqual(['{"phase":"authorize","fixture":"é"}', '{"phase":"enroll"}']);
    expect(write.mock.calls).toEqual([[Buffer.from('{"allow":true}\n')], [Buffer.from('{"allow":true}\n')]]);
    expect(fail).not.toHaveBeenCalled();
  });

  it("rejects oversize, unterminated, malformed UTF-8 and excessive frames", async () => {
    for (const source of [Buffer.alloc(128 * 1024 + 1, 120), Buffer.from("unterminated"),
      Buffer.from([0xc3, 0x28, 10]), Buffer.from("{}\n".repeat(13))]) {
      const fail = vi.fn();
      const dialog = new BoatBootstrapDialog(async () => undefined, vi.fn(), fail);
      dialog.feed(source);
      await expect(dialog.finish()).rejects.toThrow("Bootstrap dialogue failed");
      expect(fail).toHaveBeenCalledOnce();
    }
  });

  it("never forwards exceptions, multiline replies or replies after cancellation", async () => {
    for (const response of ["one\ntwo", "x".repeat(128 * 1024 + 1)]) {
      const write = vi.fn();
      const dialog = new BoatBootstrapDialog(async () => response, write, vi.fn());
      dialog.feed(Buffer.from("{}\n"));
      await expect(dialog.finish()).rejects.toThrow("Bootstrap dialogue failed");
      expect(write).not.toHaveBeenCalled();
    }
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const write = vi.fn();
    const dialog = new BoatBootstrapDialog(async () => { await pending; return "private-canary"; }, write, vi.fn());
    dialog.feed(Buffer.from("{}\n"));
    dialog.cancel(); release();
    await expect(dialog.finish()).rejects.toThrow("Bootstrap dialogue failed");
    expect(write).not.toHaveBeenCalled();
  });
});
