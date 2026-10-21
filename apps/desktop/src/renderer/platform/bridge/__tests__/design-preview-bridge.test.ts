import { afterEach, expect, it, vi } from "vitest";
import { DESIGN_CAPTURE_TIMEOUT_MS } from "@zeros/protocol/design-capture";
import { bridgeDesignPreview } from "../design-bridge";
import type { RuntimeClient } from "../ws-client";

afterEach(() => vi.useRealTimers());

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
