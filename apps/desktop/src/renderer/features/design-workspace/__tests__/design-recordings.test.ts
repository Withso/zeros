import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DesignRecordingChunks } from "../gpu/design-recording-chunks";
import {
  DesignRecordings,
  designRecordingsOwnerKey,
  type DesignRecordingsOwner,
  type DesignRecordingsSource,
} from "../gpu/design-recordings";
import type { DesignRecordingsReadReply, DesignRecordingsReply } from "../gpu/design-recordings-wire";

const version = (n: number) => n.toString(16).padStart(24, "0");
const owner: DesignRecordingsOwner = { workspaceId: "/work/a", directoryId: "design_a", theme: null };
const other: DesignRecordingsOwner = { workspaceId: "/work/b", directoryId: "design_b", theme: "dark" };
const chunk = (text: string) => ({
  id: createHash("sha256").update(text).digest("hex").slice(0, 32),
  data: Buffer.from(text).toString("base64"),
});
const FONT = chunk("shared-font-bytes");

interface Call {
  op: "read" | "render";
  owner: DesignRecordingsOwner;
  frames: ReadonlyArray<{ file: string; sourceVersion?: string }>;
  known: readonly string[];
  signal: AbortSignal;
  resolve(reply: DesignRecordingsReply | DesignRecordingsReadReply): void;
  reject(error: unknown): void;
}

/** A source whose replies the test releases one at a time, so every
 * interleaving the canvas can see is reproducible. */
function heldSource() {
  const calls: Call[] = [];
  const source: DesignRecordingsSource = {
    read: (owner, frames, known, signal) => new Promise((resolve, reject) =>
      calls.push({ op: "read", owner, frames, known, signal, resolve: resolve as Call["resolve"], reject })),
    render: (owner, frames, known, signal) => new Promise((resolve, reject) =>
      calls.push({ op: "render", owner, frames, known, signal, resolve: resolve as Call["resolve"], reject })),
  };
  return { calls, source };
}

function recordingOf(file: string, sourceVersion: string, drawing = chunk(`drawing:${file}:${sourceVersion}`)) {
  return {
    recording: { file, sourceVersion, width: 400, height: 300, scale: 2,
      layers: [{ x: 0, y: 0, width: 800, height: 600, chunks: [FONT.id, drawing.id] }] },
    drawing,
  };
}

function replyFor(frames: ReadonlyArray<{ file: string; sourceVersion?: string }>, known: readonly string[] = [], pipeline = "pipeline-1"):
  DesignRecordingsReply {
  const recordings = frames.map(frame => recordingOf(frame.file, frame.sourceVersion ?? version(1)));
  const chunks = new Map<string, { id: string; data: string }>();
  for (const { drawing } of recordings) chunks.set(drawing.id, drawing);
  chunks.set(FONT.id, FONT);
  return { pipeline, recordings: recordings.map(entry => entry.recording),
    chunks: [...chunks.values()].filter(entry => !known.includes(entry.id)), failed: [], deferred: [] };
}

function harness() {
  const { calls, source } = heldSource();
  const chunks = new DesignRecordingChunks();
  const recordings = new DesignRecordings({ source, chunks });
  const changes: string[][] = [];
  recordings.subscribe((key, files) => changes.push([key, ...files]));
  return { calls, chunks, recordings, changes };
}

describe("Design recordings", () => {
  it("reads stored recordings first and records only the frames the engine is missing", async () => {
    const { calls, recordings, changes } = harness();
    const frames = [{ file: "a.html", sourceVersion: version(1) }, { file: "b.html", sourceVersion: version(2) }];
    recordings.demand(owner, frames);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "read", frames });
    const stored = replyFor([frames[0]!]);
    calls[0]!.resolve({ ...stored, missing: ["b.html"] });
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toMatchObject({ sourceVersion: version(1), current: true });
    expect(changes).toEqual([[designRecordingsOwnerKey(owner), "a.html"]]);
    expect(calls[1]).toMatchObject({ op: "render", frames: [frames[1]] });
    // The font arrived with the read; the render claims it instead of resending it.
    expect(calls[1]!.known).toContain(FONT.id);
    calls[1]!.resolve(replyFor([frames[1]!], calls[1]!.known));
    await recordings.settled();
    expect(recordings.recording(owner, "b.html")).toMatchObject({ sourceVersion: version(2), current: true });
    expect(new TextDecoder().decode(recordings.layerBytes(owner, "b.html", 0)!))
      .toBe(`shared-font-bytesdrawing:b.html:${version(2)}`);
  });

  it("keeps one request in flight until an owner's first reply, then fills two", async () => {
    const { calls, recordings } = harness();
    const frames = Array.from({ length: 200 }, (_, index) => ({ file: `f${index}.html`, sourceVersion: version(index + 1) }));
    recordings.demand(owner, frames);
    expect(calls).toHaveLength(1);
    // Center-first demand order is preserved inside and across batches.
    expect(calls[0]!.frames).toEqual(frames.slice(0, 64));
    calls[0]!.resolve({ ...replyFor(calls[0]!.frames), missing: [] });
    await recordings.settled();
    expect(calls.slice(1).map(call => call.frames[0]!.file)).toEqual(["f64.html", "f128.html"]);
    expect(calls).toHaveLength(3);
  });

  it("leases claimed chunks until the reply is processed", async () => {
    const chunks = new DesignRecordingChunks({ budgetBytes: 1 });
    const { calls, source } = heldSource();
    const recordings = new DesignRecordings({ source, chunks });
    recordings.demand(owner, [{ file: "a.html", sourceVersion: version(1) }]);
    calls[0]!.resolve({ ...replyFor(calls[0]!.frames), missing: [] });
    await recordings.settled();
    // The tiny budget keeps only leased chunks: every adopted chunk is gone
    // again, so a frame whose bytes are needed must be read once more.
    expect(chunks.usage().count).toBe(0);
    expect(recordings.layerBytes(owner, "a.html", 0)).toBeNull();
    expect(calls[1]).toMatchObject({ op: "read", frames: [{ file: "a.html", sourceVersion: version(1) }] });
  });

  it("keeps the last confirmed recording while a new generation is requested", async () => {
    const { calls, recordings } = harness();
    recordings.demand(owner, [{ file: "a.html", sourceVersion: version(1) }]);
    calls[0]!.resolve({ ...replyFor(calls[0]!.frames), missing: [] });
    await recordings.settled();
    recordings.demand(owner, [{ file: "a.html", sourceVersion: version(2) }]);
    expect(recordings.recording(owner, "a.html")).toMatchObject({ sourceVersion: version(1), current: false });
    expect(calls[1]).toMatchObject({ op: "read", frames: [{ file: "a.html", sourceVersion: version(2) }] });
    // The engine never stored v2; the render reply replaces v1 in one step.
    calls[1]!.resolve({ ...replyFor([], calls[1]!.known), missing: ["a.html"] });
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toMatchObject({ sourceVersion: version(1), current: false });
    calls[2]!.resolve(replyFor(calls[2]!.frames, calls[2]!.known));
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toMatchObject({ sourceVersion: version(2), current: true });
  });

  it("reads an unprepared frame's newest stored recording as an unchecked cover", async () => {
    const { calls, recordings } = harness();
    recordings.demand(owner, [{ file: "a.html" }]);
    expect(calls[0]).toMatchObject({ op: "read", frames: [{ file: "a.html" }] });
    calls[0]!.resolve({ ...replyFor([{ file: "a.html", sourceVersion: version(7) }]), missing: [] });
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toMatchObject({ sourceVersion: version(7), current: false });
    // Without a stored recording an unprepared frame waits for preparation; it
    // never asks the engine to record a version it cannot name.
    recordings.demand(owner, [{ file: "b.html" }]);
    calls[1]!.resolve({ ...replyFor([]), missing: ["b.html"] });
    await recordings.settled();
    expect(calls).toHaveLength(2);
    recordings.demand(owner, [{ file: "a.html", sourceVersion: version(7) }]);
    expect(recordings.recording(owner, "a.html")).toMatchObject({ sourceVersion: version(7), current: true });
    expect(calls).toHaveLength(2);
  });

  it("fences replies by exact owner and drops a forgotten owner's late reply", async () => {
    const { calls, recordings } = harness();
    recordings.demand(owner, [{ file: "a.html", sourceVersion: version(1) }]);
    recordings.demand(other, [{ file: "a.html", sourceVersion: version(9) }]);
    expect(calls.map(call => call.owner)).toEqual([owner, other]);
    calls[1]!.resolve({ ...replyFor(calls[1]!.frames), missing: [] });
    await recordings.settled();
    expect(recordings.recording(other, "a.html")).toMatchObject({ sourceVersion: version(9) });
    expect(recordings.recording(owner, "a.html")).toBeNull();
    recordings.forgetWorkspaces([owner.workspaceId]);
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.resolve({ ...replyFor(calls[0]!.frames), missing: [] });
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toBeNull();
    // A → B → A: the retained owner's confirmed recording is still there.
    recordings.demand(other, [{ file: "a.html", sourceVersion: version(9) }]);
    expect(recordings.recording(other, "a.html")).toMatchObject({ sourceVersion: version(9), current: true });
  });

  it("retires a failed version, asks deferred frames again a bounded number of times, and fails frames with a corrupt chunk", async () => {
    const { calls, recordings } = harness();
    const frames = [{ file: "a.html", sourceVersion: version(1) }, { file: "b.html", sourceVersion: version(2) },
      { file: "c.html", sourceVersion: version(3) }];
    recordings.demand(owner, frames);
    calls[0]!.resolve({ ...replyFor([]), missing: frames.map(frame => frame.file) });
    await recordings.settled();
    const corrupt = recordingOf("c.html", version(3));
    calls[1]!.resolve({ pipeline: "pipeline-1", recordings: [corrupt.recording],
      chunks: [FONT, { id: corrupt.drawing.id, data: Buffer.from("tampered").toString("base64") }],
      failed: [{ file: "a.html", error: "layout failed" }], deferred: ["b.html"] });
    await recordings.settled();
    expect(recordings.recording(owner, "c.html")).toBeNull();
    expect(recordings.failure(owner, "a.html")).toBe("layout failed");
    expect(recordings.failure(owner, "c.html")).toMatch(/chunk/i);
    for (let attempt = 0; attempt < 3; attempt++) {
      const call = calls.at(-1)!;
      expect(call.frames).toEqual([frames[1]]);
      call.resolve({ ...replyFor([]), deferred: ["b.html"] });
      await recordings.settled();
    }
    expect(recordings.failure(owner, "b.html")).toMatch(/deferr/i);
    const count = calls.length;
    recordings.demand(owner, frames);
    expect(calls).toHaveLength(count);
  });

  it("re-requests recordings drawn by another pipeline but keeps them painted meanwhile", async () => {
    const { calls, recordings } = harness();
    recordings.demand(owner, [{ file: "a.html", sourceVersion: version(1) }, { file: "b.html", sourceVersion: version(2) }]);
    calls[0]!.resolve({ ...replyFor([calls[0]!.frames[0]!]), missing: ["b.html"] });
    await recordings.settled();
    calls[1]!.resolve(replyFor(calls[1]!.frames, calls[1]!.known, "pipeline-2"));
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toMatchObject({ current: false });
    expect(calls[2]).toMatchObject({ op: "render", frames: [{ file: "a.html", sourceVersion: version(1) }] });
  });

  it("cancels a request whose frames are no longer demanded", async () => {
    const { calls, recordings } = harness();
    recordings.demand(owner, [{ file: "a.html", sourceVersion: version(1) }]);
    recordings.demand(owner, []);
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.reject(new Error("cancelled"));
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toBeNull();
    expect(recordings.usage().inFlight).toBe(0);
  });
});
