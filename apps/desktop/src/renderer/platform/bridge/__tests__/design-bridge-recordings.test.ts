import { describe, expect, it, vi } from "vitest";

import { DESIGN_PREVIEW_JOBS_CAPABILITY } from "@zeros/protocol/design-capture";
import { bridgeDesignRecordingsRead, bridgeDesignRecordingsRender } from "../design-bridge";
import type { RuntimeClient } from "../ws-client";

const version = "a".repeat(24);
const chunk = "b".repeat(32);
const recording = { file: "page-1/home.html", sourceVersion: version, width: 390, height: 844, scale: 2,
  layers: [{ x: 0, y: 0, width: 780, height: 1688, bytes: 4, chunks: [chunk], typefaces: [] }] };
const renderReply = { pipeline: "p1", recordings: [recording], typefaces: [], chunks: [{ id: chunk, data: "AAAAAA==" }],
  stale: [], failed: [], deferred: [] };

function bridgeReturning(result: (op: string) => unknown, capabilities: readonly string[] = []) {
  const request = vi.fn(async (message: { op: string; params: Record<string, unknown> }) =>
    ({ type: "WORKSPACE_RESPONSE", result: result(message.op) }));
  const bridge = { request, supportsEngineCapability: (capability: string) => capabilities.includes(capability),
    onStatusChange: () => () => {} } as unknown as RuntimeClient;
  return { bridge, request };
}

describe("Design recordings bridge", () => {
  it("renders frames as a cancellable preview job and decodes the reply strictly", async () => {
    const { bridge, request } = bridgeReturning(() => renderReply, [DESIGN_PREVIEW_JOBS_CAPABILITY]);
    const reply = await bridgeDesignRecordingsRender(bridge, "/work/local", { directoryId: "design_a", theme: null,
      frames: [{ file: recording.file, sourceVersion: version }], knownChunks: [chunk] });
    expect(reply.recordings[0]).toMatchObject({ file: recording.file, scale: 2 });
    const [message] = request.mock.calls[0]!;
    expect(message.op).toBe("design.recordings.render");
    expect(message.params).toMatchObject({ workspaceId: "/work/local", directoryId: "design_a", theme: null,
      frames: [{ file: recording.file, sourceVersion: version }], knownChunks: [chunk] });
    // The recorder reports its own scale; the renderer does not send one.
    expect(message.params).not.toHaveProperty("deviceScaleFactor");
    expect(message.params.jobId).toEqual(expect.any(String));
    expect(message.params.deadline).toEqual(expect.any(Number));
    const malformed = bridgeReturning(() => ({ ...renderReply, recordings: [{ ...recording, layers: [] }] }));
    await expect(bridgeDesignRecordingsRender(malformed.bridge, "/work/local", { directoryId: "design_a", theme: null,
      frames: [{ file: recording.file, sourceVersion: version }], knownChunks: [] })).rejects.toThrow(/malformed/);
  });

  it("reads stored recordings, with or without a known version", async () => {
    const { bridge, request } = bridgeReturning(() => ({ recordings: [{ ...recording, pipeline: "p1" }], typefaces: [],
      chunks: [], missing: ["page-1/about.html"], deferred: [] }));
    const reply = await bridgeDesignRecordingsRead(bridge, "/work/local", { directoryId: "design_a", theme: "dark",
      frames: [{ file: recording.file }, { file: "page-1/about.html", sourceVersion: version }], knownChunks: [] });
    expect(reply.missing).toEqual(["page-1/about.html"]);
    const [message] = request.mock.calls[0]!;
    expect(message.op).toBe("design.recordings.read");
    expect(message.params.frames).toEqual([{ file: recording.file }, { file: "page-1/about.html", sourceVersion: version }]);
    expect(message.params).not.toHaveProperty("knownChunks");
  });

  it("never sends a recording request for a cloud workspace", async () => {
    const { bridge, request } = bridgeReturning(() => renderReply);
    const input = { directoryId: "design_a", theme: null, frames: [{ file: recording.file, sourceVersion: version }], knownChunks: [] };
    await expect(bridgeDesignRecordingsRender(bridge, "cloud://org/workspace", input)).rejects.toThrow(/Local/);
    await expect(bridgeDesignRecordingsRead(bridge, "cloud://org/workspace", input)).rejects.toThrow(/Local/);
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels an abandoned render on the engine and confirms it", async () => {
    let release!: () => void;
    const request = vi.fn((message: { op: string }) => message.op === "design.preview.cancel"
      ? Promise.resolve({ type: "WORKSPACE_RESPONSE", result: { settled: true } })
      : new Promise((resolve) => { release = () => resolve({ type: "WORKSPACE_RESPONSE", result: renderReply }); }));
    const bridge = { request, supportsEngineCapability: (capability: string) => capability === DESIGN_PREVIEW_JOBS_CAPABILITY,
      onStatusChange: () => () => {} } as unknown as RuntimeClient;
    const controller = new AbortController();
    const pending = bridgeDesignRecordingsRender(bridge, "/work/local", { directoryId: "design_a", theme: null,
      frames: [{ file: recording.file, sourceVersion: version }], knownChunks: [] }, { signal: controller.signal });
    controller.abort(new Error("no longer shown"));
    release();
    await expect(pending).rejects.toThrow();
    const ops = request.mock.calls.map(([message]) => (message as { op: string }).op);
    expect(ops).toEqual(["design.recordings.render", "design.preview.cancel"]);
  });
});
