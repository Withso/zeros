import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DesignRecordingChunks } from "../gpu/design-recording-chunks";
import {
  DesignRecordings,
  designRecordingsOwnerKey,
  type DesignRecordingDemand,
  type DesignRecordingsOwner,
  type DesignRecordingsSource,
} from "../gpu/design-recordings";
import {
  designRecordingsReadReplySchema,
  designRecordingsReplySchema,
  type DesignRecordingsReadReply,
  type DesignRecordingsReply,
} from "../gpu/design-recordings-wire";

const version = (n: number) => n.toString(16).padStart(24, "0");
const owner: DesignRecordingsOwner = { workspaceId: "/work/a", directoryId: "design_a", theme: null };
const other: DesignRecordingsOwner = { workspaceId: "/work/b", directoryId: "design_b", theme: "dark" };
const chunk = (text: string) => ({
  id: createHash("sha256").update(text).digest("hex").slice(0, 32),
  data: Buffer.from(text).toString("base64"),
  length: Buffer.byteLength(text),
});
const SHARED = chunk("shared-drawing-prefix");
const FONT = chunk("externalized-font-file");
const FONT_ID = createHash("sha256").update("externalized-font-file").digest("hex").slice(0, 32);

interface Call {
  op: "read" | "render";
  owner: DesignRecordingsOwner;
  frames: readonly DesignRecordingDemand[];
  known: readonly string[];
  signal: AbortSignal;
  resolve(reply: DesignRecordingsReply | DesignRecordingsReadReply): void;
  reject(error: unknown): void;
}

/** A source whose replies the test releases one at a time, so every
 * interleaving the canvas can see is reproducible. Replies are checked
 * against the strict contract schemas first. */
function heldSource() {
  const calls: Call[] = [];
  const source: DesignRecordingsSource = {
    read: (owner, frames, known, signal) => new Promise((resolve, reject) =>
      calls.push({ op: "read", owner, frames, known, signal, reject,
        resolve: (reply) => resolve(designRecordingsReadReplySchema.parse(reply)) })),
    render: (owner, frames, known, signal) => new Promise((resolve, reject) =>
      calls.push({ op: "render", owner, frames, known, signal, reject,
        resolve: (reply) => resolve(designRecordingsReplySchema.parse(reply)) })),
  };
  return { calls, source };
}

function recordingOf(file: string, sourceVersion: string, options: { font?: boolean; drawing?: ReturnType<typeof chunk> } = {}) {
  const drawing = options.drawing ?? chunk(`drawing:${file}:${sourceVersion}`);
  return {
    recording: { file, sourceVersion, width: 400, height: 300, scale: 2,
      layers: [{ x: 0, y: 0, width: 800, height: 600, bytes: SHARED.length + drawing.length, chunks: [SHARED.id, drawing.id],
        typefaces: options.font ? [FONT_ID] : [] }] },
    drawing,
  };
}

function chunksFor(drawings: ReadonlyArray<ReturnType<typeof chunk>>, known: readonly string[], font: boolean) {
  const all = new Map<string, { id: string; data: string }>();
  for (const drawing of [SHARED, ...drawings, ...(font ? [FONT] : [])]) all.set(drawing.id, { id: drawing.id, data: drawing.data });
  return [...all.values()].filter((entry) => !known.includes(entry.id));
}

function renderReply(frames: readonly DesignRecordingDemand[], known: readonly string[] = [],
  options: { pipeline?: string; font?: boolean } = {}): DesignRecordingsReply {
  const recordings = frames.map((frame) => recordingOf(frame.file, frame.sourceVersion ?? version(1), { font: options.font }));
  return { pipeline: options.pipeline ?? "pipeline-1", recordings: recordings.map((entry) => entry.recording),
    typefaces: options.font ? [{ id: FONT_ID, bytes: FONT.length, chunks: [FONT.id] }] : [],
    chunks: chunksFor(recordings.map((entry) => entry.drawing), known, !!options.font), stale: [], failed: [], deferred: [] };
}

function readReply(frames: readonly DesignRecordingDemand[], missing: readonly string[], known: readonly string[] = [],
  options: { pipeline?: string; versions?: Record<string, string> } = {}): DesignRecordingsReadReply {
  const recordings = frames.filter((frame) => !missing.includes(frame.file))
    .map((frame) => recordingOf(frame.file, options.versions?.[frame.file] ?? frame.sourceVersion ?? version(1)));
  return { recordings: recordings.map((entry) => ({ ...entry.recording, pipeline: options.pipeline ?? "pipeline-1" })),
    typefaces: [], chunks: chunksFor(recordings.map((entry) => entry.drawing), known, false), missing: [...missing], deferred: [] };
}

function harness(chunks = new DesignRecordingChunks()) {
  const { calls, source } = heldSource();
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
    calls[0]!.resolve(readReply(frames, ["b.html"]));
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toMatchObject({ sourceVersion: version(1), current: true });
    expect(changes).toEqual([[designRecordingsOwnerKey(owner), "a.html"]]);
    expect(calls[1]).toMatchObject({ op: "render", frames: [frames[1]] });
    // The shared prefix arrived with the read; the render claims it.
    expect(calls[1]!.known).toContain(SHARED.id);
    calls[1]!.resolve(renderReply([frames[1]!], calls[1]!.known));
    await recordings.settled();
    expect(recordings.recording(owner, "b.html")).toMatchObject({ sourceVersion: version(2), current: true });
    expect(new TextDecoder().decode(recordings.layerBytes(owner, "b.html", 0)!))
      .toBe(`shared-drawing-prefixdrawing:b.html:${version(2)}`);
  });

  it("delivers an externalized font once and verifies its length", async () => {
    const { calls, recordings } = harness();
    const frames = [{ file: "a.html", sourceVersion: version(1) }, { file: "b.html", sourceVersion: version(2) }];
    recordings.demand(owner, [frames[0]!]);
    calls[0]!.resolve({ ...readReply([], ["a.html"]), missing: ["a.html"] });
    await recordings.settled();
    calls[1]!.resolve(renderReply([frames[0]!], calls[1]!.known, { font: true }));
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toMatchObject({ typefaces: [FONT_ID], current: true });
    expect(new TextDecoder().decode(recordings.typefaceBytes(owner, FONT_ID)!)).toBe("externalized-font-file");
    recordings.demand(owner, frames);
    // The next request claims the font's chunks; the reply that references
    // the font again need not describe it.
    expect(calls[2]!.known).toEqual(expect.arrayContaining([FONT.id, SHARED.id]));
    calls[2]!.resolve({ ...readReply([], ["b.html"], calls[2]!.known), missing: ["b.html"] });
    await recordings.settled();
    const reply = renderReply([frames[1]!], calls[3]!.known, { font: true });
    calls[3]!.resolve({ ...reply, typefaces: [] });
    await recordings.settled();
    expect(recordings.recording(owner, "b.html")).toMatchObject({ typefaces: [FONT_ID], current: true });
  });

  it("keeps one request in flight until an owner's first reply, then fills two", async () => {
    const { calls, recordings } = harness();
    const frames = Array.from({ length: 300 }, (_, index) => ({ file: `f${index}.html`, sourceVersion: version(index + 1) }));
    recordings.demand(owner, frames);
    expect(calls).toHaveLength(1);
    // Stored lookups batch wider than recordings; center-first order holds.
    expect(calls[0]!.frames).toEqual(frames.slice(0, 256));
    calls[0]!.resolve(readReply(calls[0]!.frames, calls[0]!.frames.map((frame) => frame.file)));
    await recordings.settled();
    expect(calls.slice(1).map((call) => [call.op, call.frames[0]!.file, call.frames.length]))
      .toEqual([["render", "f0.html", 64], ["render", "f64.html", 64]]);
  });

  it("reads a recording again when its chunks left the cache", async () => {
    const { calls, chunks, recordings } = harness(new DesignRecordingChunks({ budgetBytes: 1 }));
    recordings.demand(owner, [{ file: "a.html", sourceVersion: version(1) }]);
    calls[0]!.resolve(readReply(calls[0]!.frames, []));
    await recordings.settled();
    // The tiny budget keeps only leased chunks: once adopted they are gone.
    expect(chunks.usage().count).toBe(0);
    expect(recordings.recording(owner, "a.html")).toMatchObject({ current: true });
    expect(recordings.layerBytes(owner, "a.html", 0)).toBeNull();
    expect(calls[1]).toMatchObject({ op: "read", frames: [{ file: "a.html", sourceVersion: version(1) }] });
  });

  it("keeps the last confirmed recording while a new generation is requested", async () => {
    const { calls, recordings } = harness();
    recordings.demand(owner, [{ file: "a.html", sourceVersion: version(1) }]);
    calls[0]!.resolve(readReply(calls[0]!.frames, []));
    await recordings.settled();
    recordings.demand(owner, [{ file: "a.html", sourceVersion: version(2) }]);
    expect(recordings.recording(owner, "a.html")).toMatchObject({ sourceVersion: version(1), current: false });
    expect(calls[1]).toMatchObject({ op: "read", frames: [{ file: "a.html", sourceVersion: version(2) }] });
    calls[1]!.resolve(readReply(calls[1]!.frames, ["a.html"], calls[1]!.known));
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toMatchObject({ sourceVersion: version(1), current: false });
    calls[2]!.resolve(renderReply(calls[2]!.frames, calls[2]!.known));
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toMatchObject({ sourceVersion: version(2), current: true });
  });

  it("reads an unprepared frame's newest stored recording as an unchecked cover", async () => {
    const { calls, recordings } = harness();
    recordings.demand(owner, [{ file: "a.html" }]);
    expect(calls[0]).toMatchObject({ op: "read", frames: [{ file: "a.html" }] });
    expect(calls[0]!.frames[0]).not.toHaveProperty("sourceVersion");
    calls[0]!.resolve(readReply(calls[0]!.frames, [], [], { versions: { "a.html": version(7) } }));
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toMatchObject({ sourceVersion: version(7), current: false });
    // Without a stored recording an unprepared frame waits for preparation; it
    // never asks the engine to record a version it cannot name.
    recordings.demand(owner, [{ file: "b.html" }]);
    calls[1]!.resolve(readReply(calls[1]!.frames, ["b.html"]));
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
    expect(calls.map((call) => call.owner)).toEqual([owner, other]);
    calls[1]!.resolve(readReply(calls[1]!.frames, []));
    await recordings.settled();
    expect(recordings.recording(other, "a.html")).toMatchObject({ sourceVersion: version(9) });
    expect(recordings.recording(owner, "a.html")).toBeNull();
    recordings.forgetWorkspaces([owner.workspaceId]);
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.resolve(readReply(calls[0]!.frames, []));
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toBeNull();
    // A → B → A: the retained owner's confirmed recording is still there.
    recordings.demand(other, [{ file: "a.html", sourceVersion: version(9) }]);
    expect(recordings.recording(other, "a.html")).toMatchObject({ sourceVersion: version(9), current: true });
  });

  it("retires failed and superseded versions, asks deferred frames again a bounded number of times, and fails frames with a corrupt chunk", async () => {
    const { calls, recordings } = harness();
    const frames = [{ file: "a.html", sourceVersion: version(1) }, { file: "b.html", sourceVersion: version(2) },
      { file: "c.html", sourceVersion: version(3) }, { file: "d.html", sourceVersion: version(4) }];
    recordings.demand(owner, frames);
    calls[0]!.resolve(readReply(frames, frames.map((frame) => frame.file)));
    await recordings.settled();
    const corrupt = recordingOf("c.html", version(3));
    calls[1]!.resolve({ pipeline: "pipeline-1", recordings: [corrupt.recording], typefaces: [],
      chunks: [{ id: SHARED.id, data: SHARED.data }, { id: corrupt.drawing.id, data: Buffer.from("tampered").toString("base64") }],
      failed: [{ file: "a.html", error: "layout failed" }], deferred: [frames[1]!],
      stale: [{ file: "d.html", sourceVersion: version(40) }] });
    await recordings.settled();
    expect(recordings.recording(owner, "c.html")).toBeNull();
    expect(recordings.failure(owner, "a.html")).toBe("layout failed");
    expect(recordings.failure(owner, "c.html")).toMatch(/chunk/i);
    // A source that moved on is not a failure; the canvas's next demand
    // names the new version.
    expect(recordings.failure(owner, "d.html")).toBeNull();
    for (let attempt = 0; attempt < 3; attempt++) {
      const call = calls.at(-1)!;
      expect(call.frames).toEqual([frames[1]]);
      call.resolve({ ...renderReply([]), deferred: [frames[1]!] });
      await recordings.settled();
    }
    expect(recordings.failure(owner, "b.html")).toMatch(/deferr/i);
    const count = calls.length;
    recordings.demand(owner, frames);
    expect(calls).toHaveLength(count);
    recordings.demand(owner, [{ file: "d.html", sourceVersion: version(40) }]);
    expect(calls.at(-1)).toMatchObject({ frames: [{ file: "d.html", sourceVersion: version(40) }] });
  });

  it("re-records frames drawn by another pipeline but keeps them painted meanwhile", async () => {
    const { calls, recordings } = harness();
    recordings.demand(owner, [{ file: "a.html", sourceVersion: version(1) }, { file: "b.html", sourceVersion: version(2) }]);
    calls[0]!.resolve(readReply(calls[0]!.frames, ["b.html"]));
    await recordings.settled();
    calls[1]!.resolve(renderReply(calls[1]!.frames, calls[1]!.known, { pipeline: "pipeline-2" }));
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
