import { describe, expect, it, vi } from "vitest";

import { DESIGN_PREVIEW_JOBS_CAPABILITY } from "@zeros/protocol/design-capture";
import { bridgeDesignRecordingsRead, bridgeDesignRecordingsRender } from "../design-bridge";
import { DESIGN_RECORDINGS_COLOR_SCHEME_CAPABILITY, DESIGN_RECORDINGS_READ_FAILURES_CAPABILITY } from "../../../features/design-workspace/gpu/design-recordings-wire";
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

  it("decodes a newer engine's optional failure fields, and still rejects anything else unknown", async () => {
    const frames = [{ file: recording.file, sourceVersion: version }];
    const retryable = { file: "page-1/about.html", error: "The recorder page crashed.", retryable: true };
    const render = bridgeReturning(() => ({ ...renderReply, failed: [retryable] }), [DESIGN_PREVIEW_JOBS_CAPABILITY]);
    const reply = await bridgeDesignRecordingsRender(render.bridge, "/work/local", { directoryId: "design_a", theme: null,
      frames, knownChunks: [] });
    // A retryable failure must not cost the reply's recordings.
    expect(reply.recordings).toHaveLength(1);
    expect(reply.failed).toEqual([retryable]);
    const read = bridgeReturning(() => ({ recordings: [], typefaces: [], chunks: [], missing: [recording.file], deferred: [],
      failed: [{ file: "page-1/about.html", sourceVersion: version, error: "This frame paints on 2 composited layers." }] }));
    const stored = await bridgeDesignRecordingsRead(read.bridge, "/work/local", { directoryId: "design_a", theme: null,
      frames: [{ file: recording.file }], knownChunks: [] });
    expect(stored.failed).toHaveLength(1);
    const unknown = bridgeReturning(() => ({ ...renderReply, failed: [{ ...retryable, severity: 2 }] }), [DESIGN_PREVIEW_JOBS_CAPABILITY]);
    await expect(bridgeDesignRecordingsRender(unknown.bridge, "/work/local", { directoryId: "design_a", theme: null,
      frames, knownChunks: [] })).rejects.toThrow(/malformed/);
  });

  it("names the canvas's color scheme only to an engine that records schemes apart", async () => {
    const reply = () => ({ recordings: [], typefaces: [], chunks: [], missing: [recording.file], deferred: [] });
    const input = { directoryId: "design_a", theme: null, colorScheme: "dark" as const, frames: [{ file: recording.file }], knownChunks: [] };
    const older = bridgeReturning(reply);
    await bridgeDesignRecordingsRead(older.bridge, "/work/local", input);
    expect(older.request.mock.calls[0]![0].params).not.toHaveProperty("colorScheme");
    const newer = bridgeReturning((op) => (op === "design.recordings.read" ? reply() : renderReply),
      [DESIGN_RECORDINGS_COLOR_SCHEME_CAPABILITY, DESIGN_PREVIEW_JOBS_CAPABILITY]);
    await bridgeDesignRecordingsRead(newer.bridge, "/work/local", input);
    await bridgeDesignRecordingsRender(newer.bridge, "/work/local", { ...input, frames: [{ file: recording.file, sourceVersion: version }] });
    expect(newer.request.mock.calls.map(([message]) => [message.op, message.params.colorScheme]))
      .toEqual(expect.arrayContaining([["design.recordings.read", "dark"], ["design.recordings.render", "dark"]]));
  });

  it("asks a read for known failures only from an engine that advertises them", async () => {
    const reply = () => ({ recordings: [], typefaces: [], chunks: [], missing: [recording.file], deferred: [], failed: [] });
    const input = { directoryId: "design_a", theme: null, frames: [{ file: recording.file }], knownChunks: [] };
    const older = bridgeReturning(reply);
    await bridgeDesignRecordingsRead(older.bridge, "/work/local", input);
    expect(older.request.mock.calls[0]![0].params).not.toHaveProperty("withFailures");
    const newer = bridgeReturning(reply, [DESIGN_RECORDINGS_READ_FAILURES_CAPABILITY]);
    await bridgeDesignRecordingsRead(newer.bridge, "/work/local", input);
    expect(newer.request.mock.calls[0]![0].params).toMatchObject({ withFailures: true });
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
