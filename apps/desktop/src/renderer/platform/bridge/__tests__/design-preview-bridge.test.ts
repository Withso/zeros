import { afterEach, expect, it, vi } from "vitest";
import { DESIGN_CAPTURE_TIMEOUT_MS } from "@zeros/protocol/design-capture";
import { bridgeDesignPreview, rememberDesignDirectoryIdentity } from "../design-bridge";
import { designCaptureScheduler } from "../design-capture-scheduler";
import type { RuntimeClient } from "../ws-client";

afterEach(() => vi.useRealTimers());

it("cancels the exact native owner and retains shared admission through terminal acknowledgement", async () => {
  let finishPreview!: (value: unknown) => void;
  let finishCancel!: (value: unknown) => void;
  const previewReply = new Promise((resolve) => { finishPreview = resolve; });
  const cancelReply = new Promise((resolve) => { finishCancel = resolve; });
  const seen: Array<{ op: string; params: Record<string, unknown> }> = [];
  const bridge = {
    supportsEngineCapability: () => true,
    request: async (message: { op: string; params: Record<string, unknown> }) => {
      seen.push(message);
      return { type: "WORKSPACE_RESPONSE", result: await (message.op === "design.preview" ? previewReply : cancelReply) };
    },
  } as unknown as RuntimeClient;
  const controller = new AbortController();
  rememberDesignDirectoryIdentity("exact-capture", "design_newer");
  const preview = bridgeDesignPreview(bridge, "exact-capture", request, { signal: controller.signal }).catch(() => {});
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  controller.abort();
  await vi.waitFor(() => expect(seen).toHaveLength(2));
  expect(seen.map((message) => message.params.directoryId)).toEqual([request.directoryId, request.directoryId]);
  expect(seen[1]!.params.jobId).toBe(seen[0]!.params.jobId);
  const next = vi.fn(async () => {});
  const otherCapture = designCaptureScheduler.schedule("explicit-after-native", "explicit", next);
  finishPreview({ stale: true, sourceVersion: request.sourceVersion });
  await Promise.resolve();
  expect(next).not.toHaveBeenCalled();
  finishCancel({ settled: true });
  await Promise.all([preview, otherCapture]);
  expect(next).toHaveBeenCalledOnce();
});

const request = {
  directoryId: "design_directory",
  frame: "phone.html",
  sourceVersion: "a".repeat(24),
  theme: "dark",
  maxDimension: 384,
};

function bridgeReturning(result: unknown, seen: unknown[] = []) {
  return {
    request: async (message: unknown, timeoutMs: number) => {
      seen.push({ message, timeoutMs });
      return { type: "WORKSPACE_RESPONSE", result };
    },
  } as unknown as RuntimeClient;
}

it("asks for one frame's preview with the render deadline plus transport time", async () => {
  const seen: Array<{ message: { op: string; params: Record<string, unknown> }; timeoutMs: number }> = [];
  const preview = {
    sourceVersion: request.sourceVersion, theme: "dark", mimeType: "image/png",
    width: 384, height: 240, data: "iVBORw0KGgo=",
  };
  await expect(bridgeDesignPreview(bridgeReturning(preview, seen), "workspace", request)).resolves.toEqual(preview);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.message).toMatchObject({
    type: "WORKSPACE_REQUEST",
    op: "design.preview",
    params: { workspaceId: "workspace", ...request },
  });
  expect(seen[0]!.timeoutMs).toBeGreaterThan(DESIGN_CAPTURE_TIMEOUT_MS);
});

it("passes a stale answer through and refuses a malformed one", async () => {
  await expect(bridgeDesignPreview(bridgeReturning({ stale: true, sourceVersion: "b".repeat(24) }), "workspace", request))
    .resolves.toEqual({ stale: true, sourceVersion: "b".repeat(24) });
  await expect(bridgeDesignPreview(bridgeReturning({ mimeType: "image/png", data: "x" }), "workspace", request))
    .rejects.toThrow("design.preview: malformed engine response");
  await expect(bridgeDesignPreview(bridgeReturning({
    sourceVersion: request.sourceVersion, theme: "dark", mimeType: "image/png", width: 4096, height: 240, data: "x",
  }), "workspace", request)).rejects.toThrow("design.preview: malformed engine response");
});

it("accepts original terminal proof even when the cancellation transport fails", async () => {
  let finish!: (value: unknown) => void;
  const bridge = { supportsEngineCapability: () => true, request: vi.fn(async (message: { op: string }) => {
    if (message.op === "design.preview.cancel") throw new Error("cancel transport lost");
    return { type: "WORKSPACE_RESPONSE", result: await new Promise((resolve) => { finish = resolve; }) };
  }) } as unknown as RuntimeClient;
  const abort = new AbortController();
  const pending = bridgeDesignPreview(bridge, "terminal-proof", request, { signal: abort.signal });
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  abort.abort();
  finish({ stale: true, sourceVersion: request.sourceVersion });
  await rejected;
  await vi.waitFor(() => expect(designCaptureScheduler.usage().reservedBytes).toBe(0));
});

it("quarantines admission when the original connection loses terminal proof", async () => {
  // A separate application lifetime avoids resetting a real quarantine merely
  // to let the rest of this suite continue.
  vi.resetModules();
  const { bridgeDesignPreview: preview } = await import("../design-bridge");
  const { designCaptureScheduler: scheduler } = await import("../design-capture-scheduler");
  let status!: (value: string) => void;
  let fail!: (error: Error) => void;
  const call = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
  const bridge = { supportsEngineCapability: () => true,
    onStatusChange: (listener: typeof status) => { status = listener; return vi.fn(); }, request: call } as unknown as RuntimeClient;
  const pending = preview(bridge, "lost-proof", request);
  const rejected = expect(pending).rejects.toThrow(/cleanup/i);
  await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
  const next = vi.fn(async () => {});
  const queued = scheduler.schedule("after-lost-proof", "explicit", next).catch(() => {});
  status("disconnected"); status("connected");
  fail(new Error("original socket closed"));
  await rejected; await queued;
  expect(call).toHaveBeenCalledTimes(1);
  expect(next).not.toHaveBeenCalled();
  expect(scheduler.usage()).toMatchObject({ unconfirmed: 1, queued: 0, reservedBytes: 256 * 1024 * 1024 });
  await expect(scheduler.schedule("later", "explicit", next)).rejects.toThrow(/cleanup/i);
});
