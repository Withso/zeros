import { describe, expect, it } from "vitest";
import {
  DESIGN_RECORDINGS_REPLY_DATA_BYTES,
  designBatchRecordReplySchema,
  designBatchRecordRequestSchema,
  designRecordingsReadReplySchema,
  designRecordingsReadSchema,
  designRecordingsRenderSchema,
  designRecordingsReplySchema,
} from "../design-capture";

const version = "a".repeat(24);
const chunk = "b".repeat(32);
const recording = {
  file: "page-1/home.html", sourceVersion: version, width: 1440, height: 900, scale: 2,
  layers: [{ x: 0, y: 0, width: 2880, height: 1800, bytes: 4096, chunks: [chunk], typefaces: ["c".repeat(32)] }],
};

describe("design recordings protocol", () => {
  it("renders distinct versioned frames, optionally naming known chunks", () => {
    const input = { workspaceId: "ws", directoryId: "design_1", theme: null, frames: [{ file: "page-1/home.html", sourceVersion: version }], knownChunks: [chunk] };
    expect(designRecordingsRenderSchema.parse(input)).toEqual(input);
    expect(() => designRecordingsRenderSchema.parse({ ...input, frames: [input.frames[0], input.frames[0]] })).toThrow(/distinct/);
    expect(() => designRecordingsRenderSchema.parse({ ...input, frames: [{ file: "page-1/home.html" }] })).toThrow();
    expect(() => designRecordingsRenderSchema.parse({ ...input, knownChunks: ["not-a-chunk"] })).toThrow();
    expect(() => designRecordingsRenderSchema.parse({ ...input, jobId: "00000000-0000-4000-8000-000000000000" })).toThrow(/together/);
  });

  it("reads stored recordings for frames sent without a version", () => {
    const input = { workspaceId: "ws", directoryId: "design_1", theme: "dark", frames: [{ file: "page-1/home.html" }] };
    expect(designRecordingsReadSchema.parse(input)).toEqual(input);
  });

  it("keeps a reply's chunk data within one bridge frame", () => {
    const reply = { pipeline: "recordings-1:electron/chromium", recordings: [recording], typefaces: [{ id: "c".repeat(32), bytes: 3, chunks: [chunk] }],
      chunks: [{ id: chunk, data: "AAAA" }], stale: [], failed: [], deferred: [] };
    expect(designRecordingsReplySchema.parse(reply)).toEqual(reply);
    const full = "A".repeat(87_384);
    const many = Array.from({ length: Math.ceil(DESIGN_RECORDINGS_REPLY_DATA_BYTES / full.length) + 1 }, (_, i) => ({ id: i.toString(16).padStart(32, "0"), data: full }));
    expect(() => designRecordingsReplySchema.parse({ ...reply, chunks: many })).toThrow(/exceed one reply/);
    expect(designRecordingsReadReplySchema.parse({ recordings: [{ ...recording, pipeline: "p" }], typefaces: [], chunks: [], missing: [], deferred: [] }).recordings).toHaveLength(1);
  });

  it("rejects a recording without layers or with a malformed chunk", () => {
    const reply = { pipeline: "p", typefaces: [], chunks: [], stale: [], failed: [], deferred: [] };
    expect(() => designRecordingsReplySchema.parse({ ...reply, recordings: [{ ...recording, layers: [] }] })).toThrow();
    expect(() => designRecordingsReplySchema.parse({ ...reply, recordings: [{ ...recording, layers: [{ ...recording.layers[0], chunks: ["x"] }] }] })).toThrow();
  });

  it("asks the capture host to record documents at their own viewport", () => {
    const request = { version: 1, revision: "r1", colorScheme: "light", stylesheets: { ["c".repeat(64)]: "body{}" },
      items: [{ id: "f0", html: "<!doctype html><p>x</p>", viewport: { width: 1440, height: 900 } }] };
    expect(designBatchRecordRequestSchema.parse(request)).toEqual(request);
    expect(() => designBatchRecordRequestSchema.parse({ ...request, items: [request.items[0], request.items[0]] })).toThrow(/unique/);
    const reply = { version: 1, revision: "r1", recorder: "electron-43/chromium-150/skp",
      items: [{ id: "f0", scale: 2, layers: [{ x: 0, y: 0, width: 2880, height: 1800, path: "/tmp/zeros-design-recorder-x/f0/layer_0.skp",
        typefaces: [{ id: "c".repeat(32), path: "/tmp/zeros-design-recorder-x/typefaces/" + "c".repeat(32) + ".font" }] }] },
        { id: "f1", error: "This frame has content on separate layers.", permanent: true }] };
    expect(designBatchRecordReplySchema.parse(reply)).toEqual(reply);
    expect(() => designBatchRecordReplySchema.parse({ ...reply, items: [{ id: "f1", error: "x", permanent: false }] })).toThrow();
  });
});
