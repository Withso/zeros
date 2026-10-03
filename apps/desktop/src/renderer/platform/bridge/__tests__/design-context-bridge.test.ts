import { afterEach, expect, it, vi } from "vitest";
import { DESIGN_CAPTURE_TIMEOUT_MS } from "@zeros/protocol/design-capture";
import { captureDesignFrameContext } from "../design-context-bridge";
import type { RuntimeClient } from "../ws-client";

afterEach(() => vi.useRealTimers());

it("accepts a capture that needs the renderer deadline plus transport time", async () => {
  vi.useFakeTimers();
  const reference = {
    version: 1 as const,
    workspaceId: "workspace",
    directoryId: "design_directory",
    frame: "phone.html",
    frameId: "frame_phone",
    revision: "a".repeat(24),
  };
  const result = { reference, mimeType: "image/png", data: "cG5n" };
  const bridge = {
    request: (message: { op: string }, timeoutMs: number) =>
      new Promise((resolve, reject) => {
        expect(message.op).toBe("design.context.capture");
        const timeout = setTimeout(
          () => reject(new Error("Request timeout")),
          timeoutMs,
        );
        setTimeout(() => {
          clearTimeout(timeout);
          resolve({ type: "WORKSPACE_RESPONSE", result });
        }, DESIGN_CAPTURE_TIMEOUT_MS + 2_000);
      }),
  } as unknown as RuntimeClient;
  const received = captureDesignFrameContext(bridge, reference).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.runAllTimersAsync();
  expect(await received).toEqual({ value: result });
});
