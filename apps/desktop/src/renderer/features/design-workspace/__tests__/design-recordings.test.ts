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
const owner: DesignRecordingsOwner = { workspaceId: "/work/a", directoryId: "design_a", theme: null, colorScheme: "light" };
const other: DesignRecordingsOwner = { workspaceId: "/work/b", directoryId: "design_b", theme: "dark", colorScheme: "light" };
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

  it("times each reply's round trip by operation, and its adoption, for the bench", async () => {
    const { calls, recordings } = harness();
    const frames = [{ file: "a.html", sourceVersion: version(1) }];
    recordings.demand(owner, frames);
    calls[0]!.resolve(readReply(frames, ["a.html"]));
    await recordings.settled();
    calls[1]!.resolve(renderReply(frames, calls[1]!.known));
    await recordings.settled();
    const timings = recordings.timings();
    expect([timings.read.length, timings.render.length, timings.adopt.length]).toEqual([1, 1, 2]);
    expect([...timings.read, ...timings.render, ...timings.adopt].every((step) => step.ms >= 0 && step.at > 0)).toBe(true);
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

  it("reads one batch at a time, so two replies never carry the chunks their frames share", async () => {
    // A 1,000-frame reload: unprepared frames are read without a version. Two
    // reads in flight each carried the same new chunks (12 MB apiece), since
    // neither request could claim what the other's reply would bring.
    const { calls, recordings } = harness();
    const frames = Array.from({ length: 800 }, (_, index) => ({ file: `f${index}.html` }));
    recordings.demand(owner, frames);
    expect(calls).toHaveLength(1);
    calls[0]!.resolve(readReply(calls[0]!.frames, []));
    await recordings.settled();
    expect(calls.slice(1).map((call) => [call.op, call.frames[0]!.file, call.frames.length])).toEqual([["read", "f256.html", 256]]);
    // The next read claims what the last reply delivered.
    expect(calls[1]!.known).toContain(SHARED.id);
    calls[1]!.resolve(readReply(calls[1]!.frames, [], calls[1]!.known));
    await recordings.settled();
    expect(calls.slice(2).map((call) => [call.op, call.frames[0]!.file])).toEqual([["read", "f512.html"]]);
  });

  it("doesn't hold the next read behind one whose frames are no longer shown", async () => {
    // A stored lookup can't be cancelled, so an abandoned read stays in flight
    // until the engine answers; its reply is dropped, so waiting saves nothing.
    const { calls, recordings } = harness();
    recordings.demand(owner, [{ file: "first.html" }]);
    calls[0]!.resolve(readReply(calls[0]!.frames, []));
    await recordings.settled();
    recordings.demand(owner, Array.from({ length: 10 }, (_, index) => ({ file: `old${index}.html` })));
    expect(calls.slice(1).map((call) => call.frames[0]!.file)).toEqual(["old0.html"]);
    recordings.demand(owner, Array.from({ length: 10 }, (_, index) => ({ file: `new${index}.html` })));
    expect(calls[1]!.signal.aborted).toBe(true);
    expect(calls.slice(2).map((call) => [call.op, call.frames[0]!.file])).toEqual([["read", "new0.html"]]);
  });

  it("still records while a read is in flight", async () => {
    const { calls, recordings } = harness();
    const recorded = Array.from({ length: 64 }, (_, index) => ({ file: `r${index}.html`, sourceVersion: version(index + 1) }));
    const unread = Array.from({ length: 300 }, (_, index) => ({ file: `u${index}.html` }));
    recordings.demand(owner, [...recorded, ...unread]);
    // Nothing stored for the recorded frames: they need recording.
    calls[0]!.resolve(readReply(calls[0]!.frames, calls[0]!.frames.filter((frame) => frame.sourceVersion).map((frame) => frame.file)));
    await recordings.settled();
    expect(calls.slice(1).map((call) => call.op).sort()).toEqual(["read", "render"]);
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

  it("keeps a frame's light and dark recordings apart: a scheme switch is an owner change", async () => {
    const { calls, recordings } = harness();
    const dark: DesignRecordingsOwner = { ...owner, colorScheme: "dark" };
    expect(designRecordingsOwnerKey(dark)).not.toBe(designRecordingsOwnerKey(owner));
    const frames = [{ file: "a.html", sourceVersion: version(1) }];
    recordings.demand(owner, frames);
    // The canvas switches to dark before the light reply lands.
    recordings.demand(owner, []);
    recordings.demand(dark, frames);
    expect(calls.map((call) => call.owner.colorScheme)).toEqual(["light", "dark"]);
    calls[0]!.resolve(readReply(frames, []));
    await recordings.settled();
    expect(recordings.recording(dark, "a.html")).toBeNull();
    calls[1]!.resolve(readReply(frames, [], calls[1]!.known, { versions: { "a.html": version(1) } }));
    await recordings.settled();
    expect(recordings.recording(dark, "a.html")).toMatchObject({ sourceVersion: version(1), current: true });
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
    // Deferred behind other frames it was not tried; asked first, it fails
    // after four deferrals.
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(recordings.failure(owner, "b.html")).toBeNull();
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

  it("never fails a frame the engine left for a later request, however often", async () => {
    const { calls, recordings } = harness();
    const frames = Array.from({ length: 6 }, (_, index) => ({ file: `f${index}.html`, sourceVersion: version(index + 1) }));
    recordings.demand(owner, frames);
    // Each reply answers only its first frame and defers the rest, as an
    // engine filling one bridge frame with large recordings does.
    for (let round = 0; round < 6; round++) {
      const call = calls.at(-1)!;
      const [first, ...rest] = call.frames;
      call.resolve({ ...readReply([first!], [], call.known), deferred: rest.map((frame) => frame.file) });
      await recordings.settled();
    }
    for (const frame of frames) {
      expect(recordings.failure(owner, frame.file)).toBeNull();
      expect(recordings.recording(owner, frame.file)).toMatchObject({ current: true });
    }
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

  it("keeps its recordings current when a render reply records nothing", async () => {
    const { calls, recordings } = harness();
    recordings.demand(owner, [{ file: "a.html", sourceVersion: version(1) }, { file: "b.html", sourceVersion: version(2) }]);
    calls[0]!.resolve(readReply(calls[0]!.frames, ["b.html"]));
    await recordings.settled();
    calls[1]!.resolve(renderReply(calls[1]!.frames, calls[1]!.known));
    await recordings.settled();
    recordings.demand(owner, [{ file: "a.html", sourceVersion: version(1) }, { file: "b.html", sourceVersion: version(2) },
      { file: "c.html", sourceVersion: version(3) }]);
    calls.at(-1)!.resolve(readReply(calls.at(-1)!.frames, ["c.html"], calls.at(-1)!.known));
    await recordings.settled();
    // Every frame failed: the reply names the composer's bare pipeline.
    calls.at(-1)!.resolve({ ...renderReply([], calls.at(-1)!.known, { pipeline: "recordings-1" }),
      failed: [{ file: "c.html", error: "layout failed" }] });
    await recordings.settled();
    const count = calls.length;
    expect(recordings.recording(owner, "a.html")).toMatchObject({ current: true });
    expect(recordings.recording(owner, "b.html")).toMatchObject({ current: true });
    expect(calls).toHaveLength(count);
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

  it("covers a retryable failure at once, asks again after 2, 4 and 8 s, then keeps it; a recorded retry replaces it", async () => {
    let now = 0;
    const timers: Array<{ at: number; callback: () => void; cleared: boolean }> = [];
    const { calls, source } = heldSource();
    const recordings = new DesignRecordings({ source, chunks: new DesignRecordingChunks(), now: () => now,
      setTimer: (callback, ms) => { const timer = { at: now + ms, callback, cleared: false }; timers.push(timer); return timer; },
      clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true; } });
    const advance = async (ms: number) => {
      now += ms;
      for (const timer of timers) if (!timer.cleared && timer.at <= now) { timer.cleared = true; timer.callback(); }
      await recordings.settled();
    };
    const frames = [{ file: "a.html", sourceVersion: version(1) }, { file: "b.html", sourceVersion: version(1) }];
    recordings.demand(owner, frames);
    calls[0]!.resolve(readReply(frames, ["a.html", "b.html"]));
    await recordings.settled();
    const crashed = (call: Call, retryable = true) => call.resolve({ ...renderReply([], call.known),
      failed: call.frames.map((frame) => ({ file: frame.file, error: "The recorder page crashed.", ...(retryable ? { retryable } : {}) })) });
    // b fails for good; a's attempt failed, not the frame.
    calls[1]!.resolve({ ...renderReply([], calls[1]!.known), failed: [
      { file: "a.html", error: "The recorder page crashed.", retryable: true }, { file: "b.html", error: "This frame paints on 2 layers." }] });
    await recordings.settled();
    expect([...recordings.failedFiles(owner)].sort()).toEqual(["a.html", "b.html"]);
    for (const [wait, index] of [[2_000, 2], [4_000, 3], [8_000, 4]] as const) {
      await advance(wait - 1);
      expect(calls).toHaveLength(index);
      await advance(1);
      expect(calls[index]).toMatchObject({ op: "render", frames: [{ file: "a.html", sourceVersion: version(1) }] });
      crashed(calls[index]!);
      await recordings.settled();
    }
    // Three retries spent: the failure stays until the frame's version changes.
    await advance(60_000);
    expect(calls).toHaveLength(5);
    expect(recordings.failedFiles(owner).has("a.html")).toBe(true);
    // A new version asks again; its retry that records replaces the failure.
    recordings.demand(owner, [{ file: "a.html", sourceVersion: version(2) }, frames[1]!]);
    calls[5]!.resolve(readReply(calls[5]!.frames, ["a.html"], calls[5]!.known));
    await recordings.settled();
    crashed(calls[6]!);
    await recordings.settled();
    expect(recordings.failedFiles(owner).has("a.html")).toBe(true);
    await advance(2_000);
    calls[7]!.resolve(renderReply(calls[7]!.frames, calls[7]!.known));
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toMatchObject({ sourceVersion: version(2), current: true });
    expect([...recordings.failedFiles(owner)]).toEqual(["b.html"]);
  });

  it("takes a reopen's known failures as failed at once, for that version or a frame without one", async () => {
    const { calls, recordings } = harness();
    recordings.demand(owner, [{ file: "a.html" }, { file: "b.html", sourceVersion: version(1) }, { file: "c.html", sourceVersion: version(2) }]);
    const layers = "This frame paints on 2 composited layers.";
    calls[0]!.resolve({ ...readReply(calls[0]!.frames, ["a.html", "b.html", "c.html"]), failed: [
      { file: "a.html", sourceVersion: version(5), error: layers },
      { file: "b.html", sourceVersion: version(1), error: layers },
      { file: "c.html", sourceVersion: version(1), error: layers }] });
    await recordings.settled();
    // a (still unprepared) and b are covered by their live documents now;
    // c's failure was another version's, so c is recorded as usual.
    expect([...recordings.failedFiles(owner)].sort()).toEqual(["a.html", "b.html"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ op: "render", frames: [{ file: "c.html", sourceVersion: version(2) }] });
  });

  it("fails a frame whose recording this renderer can't draw, and only drops an older cover it can't draw", async () => {
    const { calls, chunks, recordings, changes } = harness();
    const both = (a: number, b: number) => [{ file: "a.html", sourceVersion: version(a) }, { file: "b.html", sourceVersion: version(b) }];
    recordings.demand(owner, both(1, 1));
    calls[0]!.resolve(readReply(calls[0]!.frames, []));
    await recordings.settled();
    const a = recordings.recording(owner, "a.html")!;
    const aDrawing = a.layers[0]!.chunks[1]!;
    expect(chunks.known([], 10)).toContain(aDrawing);
    changes.length = 0;
    // CanvasKit rejected a's picture: the frame fails this version, so the
    // canvas covers it another way, and nothing asks for it again.
    recordings.failUndrawable(owner, (recording) => recording.key === a.key ? "The recording could not be read." : null);
    expect(recordings.recording(owner, "a.html")).toBeNull();
    expect([...recordings.failedFiles(owner)]).toEqual(["a.html"]);
    expect(recordings.failure(owner, "a.html")).toBe("The recording could not be read.");
    expect(chunks.known([], 10)).not.toContain(aDrawing);
    expect(changes).toEqual([[designRecordingsOwnerKey(owner), "a.html"]]);
    expect(calls).toHaveLength(1);
    // b's version-1 recording is only a cover while version 2 is asked for.
    recordings.demand(owner, both(1, 2));
    const b = recordings.recording(owner, "b.html")!;
    expect(b).toMatchObject({ sourceVersion: version(1), current: false });
    expect(calls[1]).toMatchObject({ op: "read", frames: [{ file: "b.html", sourceVersion: version(2) }] });
    recordings.failUndrawable(owner, (recording) => recording.key === b.key ? "A font this frame uses failed its check." : null);
    expect(recordings.recording(owner, "b.html")).toBeNull();
    expect(recordings.failedFiles(owner).has("b.html")).toBe(false);
    calls[1]!.resolve(readReply(calls[1]!.frames, ["b.html"], calls[1]!.known));
    await recordings.settled();
    calls[2]!.resolve(renderReply(calls[2]!.frames, calls[2]!.known));
    await recordings.settled();
    expect(recordings.recording(owner, "b.html")).toMatchObject({ sourceVersion: version(2), current: true });
    // A new version of a is asked for again, and replaces the failure.
    recordings.demand(owner, both(2, 2));
    expect(calls[3]).toMatchObject({ op: "read", frames: [{ file: "a.html", sourceVersion: version(2) }] });
    calls[3]!.resolve(readReply(calls[3]!.frames, [], calls[3]!.known));
    await recordings.settled();
    expect(recordings.recording(owner, "a.html")).toMatchObject({ sourceVersion: version(2), current: true });
    expect(recordings.failedFiles(owner).size).toBe(0);
  });
});
