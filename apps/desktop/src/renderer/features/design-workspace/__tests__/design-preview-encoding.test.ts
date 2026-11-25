import { describe, expect, it, vi } from "vitest";

import { createDesignPreviewEncoder, type DesignPreviewEncodeReply, type DesignPreviewEncodeRequest } from "../state/design-preview-encoding";

function fakeWorker(answer: (request: DesignPreviewEncodeRequest) => DesignPreviewEncodeReply | null) {
  const listeners: Record<string, ((event: MessageEvent) => void)[]> = { message: [], error: [] };
  const worker = {
    posted: [] as DesignPreviewEncodeRequest[], terminated: false,
    postMessage(request: DesignPreviewEncodeRequest) {
      worker.posted.push(request);
      const reply = answer(request);
      if (reply) queueMicrotask(() => listeners.message.forEach(listener => listener({ data: reply } as MessageEvent)));
    },
    addEventListener(type: string, listener: (event: MessageEvent) => void) { listeners[type].push(listener); },
    terminate() { worker.terminated = true; },
    fail() { listeners.error.forEach(listener => listener({} as MessageEvent)); },
  };
  return worker;
}

describe("design preview encoding", () => {
  it("encodes and downscales in one worker, matching replies to their requests", async () => {
    const worker = fakeWorker(request => ({ id: request.id, blob: new Blob([request.op]) }));
    const create = vi.fn(() => worker);
    const encoder = createDesignPreviewEncoder(create);
    const [encoded, reduced] = await Promise.all([encoder.encode(new Blob(["png"]), "overview"),
      encoder.downscale(new Blob(["png"]), 16, 12, "mini")]);
    expect([await encoded.text(), await reduced.text()]).toEqual(["encode", "downscale"]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(worker.posted.map(request => request.op)).toEqual(["encode", "downscale"]);
    expect(worker.posted[1]).toMatchObject({ width: 16, height: 12, level: "mini" });
  });

  it("rejects a picture the worker could not encode", async () => {
    const encoder = createDesignPreviewEncoder(() => fakeWorker(request => ({ id: request.id, error: "bad picture" })));
    await expect(encoder.encode(new Blob(["png"]), "detail")).rejects.toThrow("bad picture");
  });

  it("finishes pending and later pictures on this thread when the worker dies or cannot start", async () => {
    // Without OffscreenCanvas the in-thread encoder keeps the PNG it was given.
    const worker = fakeWorker(() => null);
    const encoder = createDesignPreviewEncoder(() => worker);
    const png = new Blob(["png"]);
    const pending = encoder.encode(png, "overview");
    worker.fail();
    expect(await pending).toBe(png);
    expect(worker.terminated).toBe(true);
    expect(await encoder.encode(png, "overview")).toBe(png);
    expect(worker.posted).toHaveLength(1);
    const unavailable = createDesignPreviewEncoder(() => { throw new Error("no workers"); });
    expect(await unavailable.encode(png, "overview")).toBe(png);
    expect(await createDesignPreviewEncoder(null).encode(png, "overview")).toBe(png);
  });
});
