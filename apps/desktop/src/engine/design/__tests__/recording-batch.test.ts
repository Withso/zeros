import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { designBatchRecordRequestSchema, type DesignBatchRecordReply, type DesignBatchRecordRequest } from "@zeros/protocol/design-capture";
import { DESIGN_DIRECTORY_NAME, initializeDesignDocument, prepareDesignNavigationFrames, readDesignNavigationSnapshot } from "../document";
import { designDirectoryNameFor } from "../directory-registry";
import { designDirectoryEntry } from "../metadata";
import { DESIGN_RECORDER_FOLDER_PREFIX, designRecordingPipeline, readDesignRecordings, renderDesignRecordings } from "../recording-batch";
import { designRecordingChunkId } from "../recording-chunks";
import { resetDesignRecordingStoreCachesForTests } from "../recording-store";
import { settleDesignFontDownloadsForTests, resetDesignFontsForTests } from "../style-fonts";

const RECORDER = "electron-43.8.3/chromium-150.0.7871.250/skp";

describe("Design recordings", () => {
  let root: string;
  let folder: string;
  let directoryId: string;
  const recorderFolders: string[] = [];
  const frame = (text: string) => `<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="m" class="hero">${text}</main></body></html>`;
  const versions = async (files: string[]) => {
    const navigation = await readDesignNavigationSnapshot(root);
    const out = new Map<string, string>();
    for (const entry of (await prepareDesignNavigationFrames(root, navigation.catalogRevision, files)).frames) out.set(entry.file, entry.sourceVersion!);
    return [...out].map(([file, sourceVersion]) => ({ file, sourceVersion }));
  };
  /** A capture host stand-in: writes each frame's "picture" where a recorder would. */
  const recorder = (options: { bytes?: (id: string) => Uint8Array; error?: (id: string) => string | null; permanent?: boolean; pathFor?: (id: string, real: string) => string;
    fonts?: (id: string) => Array<{ id: string; bytes: Uint8Array }> } = {}) => {
    const calls: DesignBatchRecordRequest[] = [];
    const record = async (request: DesignBatchRecordRequest): Promise<DesignBatchRecordReply> => {
      calls.push(designBatchRecordRequestSchema.parse(request));
      const base = await mkdtemp(path.join(tmpdir(), DESIGN_RECORDER_FOLDER_PREFIX));
      recorderFolders.push(base);
      const items = [];
      for (const item of request.items) {
        const error = options.error?.(item.id) ?? null;
        if (error) { items.push({ id: item.id, error, ...(options.permanent ? { permanent: true as const } : {}) }); continue; }
        const dir = path.join(base, item.id);
        await mkdir(dir);
        const file = path.join(dir, "layer_0.skp");
        await writeFile(file, options.bytes?.(item.id) ?? Buffer.concat([Buffer.from("skiapict"), randomBytes(40_000)]));
        const typefaces = [];
        for (const font of options.fonts?.(item.id) ?? []) {
          await mkdir(path.join(base, "typefaces"), { recursive: true });
          const fontFile = path.join(base, "typefaces", `${font.id}.font`);
          await writeFile(fontFile, font.bytes);
          typefaces.push({ id: font.id, path: fontFile });
        }
        items.push({ id: item.id, scale: 2, layers: [{ x: 0, y: 0, width: item.viewport.width * 2, height: item.viewport.height * 2, path: options.pathFor?.(item.id, file) ?? file, typefaces }] });
      }
      return { version: 1, revision: request.revision, recorder: RECORDER, items };
    };
    return { calls, record };
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-recordings-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    folder = path.join(root, DESIGN_DIRECTORY_NAME);
    await initializeDesignDocument(root);
    directoryId = designDirectoryEntry(root, designDirectoryNameFor(root))!.id;
    await mkdir(path.join(folder, "page-1"), { recursive: true });
    await writeFile(path.join(folder, "tokens.css"), ".hero { color: red; }");
    const canvasFile = path.join(folder, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
    for (const [index, name] of ["a", "b", "c"].entries()) {
      await writeFile(path.join(folder, `page-1/${name}.html`), frame(name));
      canvas.frames[`frame_${index}`] = { kind: "html", source: `page-1/${name}.html`, title: name, x: index * 400, y: 0, width: 320, height: 200 };
      canvas.pages[0].frames.push(`frame_${index}`);
    }
    await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
  });
  afterEach(async () => {
    await settleDesignFontDownloadsForTests();
    resetDesignFontsForTests();
    resetDesignRecordingStoreCachesForTests();
    delete process.env.ZEROS_DATA_DIR;
    await Promise.all(recorderFolders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    await rm(root, { recursive: true, force: true });
  });

  it("records missing frames, stores them as chunks, and answers later requests from the store", async () => {
    const frames = await versions(["page-1/a.html", "page-1/b.html"]);
    const host = recorder();
    const first = await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames }, { record: host.record, recorder: RECORDER });
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]!.items.map((item) => item.viewport)).toEqual([{ width: 320, height: 200 }, { width: 320, height: 200 }]);
    expect(first.pipeline).toBe(designRecordingPipeline(RECORDER));
    expect(first.failed).toEqual([]);
    expect(first.recordings.map((r) => [r.file, r.width, r.height, r.scale, r.layers.length])).toEqual([["page-1/a.html", 320, 200, 2, 1], ["page-1/b.html", 320, 200, 2, 1]]);
    // Each layer's bytes are its chunks, all sent once in this reply.
    const sent = new Map(first.chunks.map((chunk) => [chunk.id, Buffer.from(chunk.data, "base64")]));
    for (const recording of first.recordings) {
      const bytes = Buffer.concat(recording.layers[0]!.chunks.map((id) => sent.get(id)!));
      expect(bytes.length).toBe(recording.layers[0]!.bytes);
      expect(bytes.subarray(0, 8).toString()).toBe("skiapict");
    }
    // The host's single-use files are gone once stored, batch folder included.
    for (const dir of recorderFolders) await expect(stat(dir)).rejects.toThrow();

    const second = await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames, knownChunks: [...sent.keys()] }, { record: host.record, recorder: RECORDER });
    expect(host.calls).toHaveLength(1);
    expect(second.recordings.map((r) => r.file)).toEqual(["page-1/a.html", "page-1/b.html"]);
    expect(second.chunks).toEqual([]);
  });

  it("reports a frame the recorder could not record, and records again after the recorder changes", async () => {
    const frames = await versions(["page-1/a.html", "page-1/b.html"]);
    const host = recorder({ error: (id) => (id === "f1" ? "This frame has content on separate composited layers." : null) });
    const reply = await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames }, { record: host.record, recorder: RECORDER });
    expect(reply.recordings.map((r) => r.file)).toEqual(["page-1/a.html"]);
    // Not marked permanent by the recorder: this attempt failed, not the frame.
    expect(reply.failed).toEqual([{ file: "page-1/b.html", error: "This frame has content on separate composited layers.", retryable: true }]);
    const updated = recorder();
    await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames: [frames[0]!] }, { record: updated.record, recorder: "electron-44/chromium-151/skp" });
    expect(updated.calls).toHaveLength(1);
  });

  it("answers a frame the recorder can't record without recording it again, until the frame or recorder changes", async () => {
    const frames = await versions(["page-1/a.html", "page-1/b.html"]);
    const error = (id: string) => (id === "f1" ? "This frame paints on 2 composited layers (640×400, 10×10), so it isn't recorded." : null);
    const host = recorder({ error, permanent: true });
    const first = await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames }, { record: host.record, recorder: RECORDER });
    expect(first.failed.map((entry) => [entry.file, entry.retryable])).toEqual([["page-1/b.html", undefined]]);
    const again = await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames: [frames[1]!] }, { record: host.record, recorder: RECORDER });
    expect(host.calls).toHaveLength(1);
    expect(again.failed).toEqual(first.failed);
    // A reopen learns it at once, before the frame is prepared, when it asks.
    const reopened = await readDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, withFailures: true,
      frames: [{ file: "page-1/a.html" }, { file: "page-1/b.html" }] }, { recorder: RECORDER });
    expect(reopened.recordings.map((recording) => recording.file)).toEqual(["page-1/a.html"]);
    expect(reopened.missing).toEqual(["page-1/b.html"]);
    expect(reopened.failed).toEqual([{ file: "page-1/b.html", sourceVersion: frames[1]!.sourceVersion, error: first.failed[0]!.error }]);
    const named = await readDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, withFailures: true,
      frames: [{ file: "page-1/b.html", sourceVersion: frames[1]!.sourceVersion }] }, { recorder: RECORDER });
    expect(named.failed).toEqual(reopened.failed);
    expect("failed" in await readDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames: [{ file: "page-1/b.html" }] },
      { recorder: RECORDER })).toBe(false);
    expect((await readDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, withFailures: true, frames: [{ file: "page-1/b.html" }] },
      { recorder: "electron-44/chromium-151/skp" })).failed).toEqual([]);
    // Another recorder tries again.
    const other = recorder({ error, permanent: true });
    await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames: [frames[1]!] }, { record: other.record, recorder: "electron-44/chromium-151/skp" });
    expect(other.calls).toHaveLength(1);
  });

  it("records each color scheme on its own, the way live frames draw in it", async () => {
    const frames = await versions(["page-1/a.html"]);
    const host = recorder();
    await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames }, { record: host.record, recorder: RECORDER });
    const dark = await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, colorScheme: "dark", frames }, { record: host.record, recorder: RECORDER });
    expect(host.calls.map((call) => call.colorScheme)).toEqual(["light", "dark"]);
    expect(dark.recordings.map((recording) => recording.file)).toEqual(["page-1/a.html"]);
    // Both are stored: neither scheme records again.
    await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, colorScheme: "light", frames }, { record: host.record, recorder: RECORDER });
    await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, colorScheme: "dark", frames }, { record: host.record, recorder: RECORDER });
    expect(host.calls).toHaveLength(2);
    const read = await readDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, colorScheme: "dark", frames: [{ file: "page-1/a.html" }] });
    expect(read.recordings[0]?.layers[0]?.chunks).toEqual(dark.recordings[0]?.layers[0]?.chunks);
  });

  it("records a request's frames in slices, the next composing while one records", async () => {
    const canvasFile = path.join(folder, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
    const files: string[] = [];
    for (let index = 3; index < 23; index++) {
      const file = `page-1/s${index}.html`;
      await writeFile(path.join(folder, file), frame(`s${index}`));
      canvas.frames[`frame_${index}`] = { kind: "html", source: file, title: `s${index}`, x: index * 400, y: 0, width: 320, height: 200 };
      canvas.pages[0].frames.push(`frame_${index}`);
      files.push(file);
    }
    await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
    // Preparation takes at most 16 frames a call.
    const frames = [...await versions(files.slice(0, 16)), ...await versions(files.slice(16))];
    const host = recorder();
    const reply = await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames }, { record: host.record, recorder: RECORDER });
    expect(host.calls.map((call) => call.items.length)).toEqual([16, 4]);
    expect(reply.recordings.map((recording) => recording.file)).toEqual(files);
  });

  it("lets two batches reach the recorder at once, and a third wait its turn", async () => {
    const frames = await versions(["page-1/a.html", "page-1/b.html", "page-1/c.html"]);
    let active = 0, peak = 0;
    const gates: Array<() => void> = [];
    const host = recorder();
    const record = async (request: DesignBatchRecordRequest) => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      try { return await host.record(request); } finally { active--; }
    };
    const replies = frames.map((frame) => renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames: [frame] }, { record, recorder: RECORDER }));
    // Turns are shared by every test: release them whatever happens here.
    const release = setInterval(() => { if (!replying) return; while (gates.length) gates.shift()!(); }, 5);
    let replying = false;
    try {
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      expect(active).toBe(2);
      // One finishes; the third takes its turn.
      gates.shift()!();
      await vi.waitFor(() => expect(gates).toHaveLength(2));
    } finally {
      replying = true;
      await Promise.allSettled(replies);
      clearInterval(release);
    }
    expect((await Promise.all(replies)).map((reply) => reply.recordings.map((r) => r.file))).toEqual(frames.map((frame) => [frame.file]));
    expect(peak).toBe(2);
  });

  it("writes each render request's time by phase when asked to", async () => {
    const file = path.join(root, "timings.jsonl");
    process.env.ZEROS_DESIGN_RECORDINGS_TIMINGS = file;
    try {
      const frames = await versions(["page-1/a.html", "page-1/b.html"]);
      await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames }, { record: recorder().record, recorder: RECORDER });
      await vi.waitFor(async () => expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(1));
      const line = JSON.parse(await readFile(file, "utf8")) as Record<string, number>;
      expect(line).toMatchObject({ frames: 2, misses: 2, batches: 1 });
      for (const phase of ["lookups", "compose", "composeWait", "recordWait", "record", "store", "total"]) expect(line[phase]).toBeGreaterThanOrEqual(0);
    } finally {
      delete process.env.ZEROS_DESIGN_RECORDINGS_TIMINGS;
    }
  });

  it("records a frame again after a failure that wasn't permanent", async () => {
    const frames = await versions(["page-1/a.html"]);
    const host = recorder({ error: () => "The recorder's page stopped (crashed) while recording this frame." });
    await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames }, { record: host.record, recorder: RECORDER });
    await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames }, { record: host.record, recorder: RECORDER });
    expect(host.calls).toHaveLength(2);
  });

  it("never reads a layer file outside the recorder's folder", async () => {
    const outside = path.join(root, "secret.skp");
    await writeFile(outside, "skiapict-not-yours");
    const frames = await versions(["page-1/a.html"]);
    const host = recorder({ pathFor: () => outside });
    const reply = await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames }, { record: host.record, recorder: RECORDER });
    expect(reply.recordings).toEqual([]);
    expect(reply.failed).toEqual([{ file: "page-1/a.html", error: "The recorder named a recording outside its folder.", retryable: true }]);
  });

  it("defers recordings whose chunks don't fit one reply, and sends shared chunks once", async () => {
    const frames = await versions(["page-1/a.html", "page-1/b.html", "page-1/c.html"]);
    const shared = randomBytes(1_000_000);
    const unique = new Map([["f0", randomBytes(5_500_000)], ["f1", randomBytes(5_500_000)], ["f2", randomBytes(100)]]);
    const host = recorder({ bytes: (id) => Buffer.concat([Buffer.from("skiapict"), shared, unique.get(id)!]) });
    const reply = await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames }, { record: host.record, recorder: RECORDER });
    expect(reply.recordings.map((r) => r.file)).toEqual(["page-1/a.html", "page-1/c.html"]);
    expect(reply.deferred).toEqual([frames[1]]);
    const ids = reply.chunks.map((chunk) => chunk.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reads each frame's newest stored recording without a version, naming its pipeline", async () => {
    const frames = await versions(["page-1/a.html"]);
    await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames }, { record: recorder().record, recorder: RECORDER });
    const read = await readDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames: [{ file: "page-1/a.html" }, { file: "page-1/b.html" }] });
    expect(read.recordings.map((r) => [r.file, r.sourceVersion, r.pipeline])).toEqual([["page-1/a.html", frames[0]!.sourceVersion, designRecordingPipeline(RECORDER)]]);
    expect(read.missing).toEqual(["page-1/b.html"]);
    expect(read.chunks.length).toBeGreaterThan(0);
  });

  it("refuses a directory that is no longer active", async () => {
    const frames = await versions(["page-1/a.html"]);
    await expect(renderDesignRecordings(root, { workspaceId: "w", directoryId: "design_other", theme: null, frames }, { record: recorder().record, recorder: RECORDER }))
      .rejects.toThrow(/directory changed/);
  });

  it("describes a typeface the reply's recordings share once, and sends its data once", async () => {
    const frames = await versions(["page-1/a.html", "page-1/b.html"]);
    const font = randomBytes(300_000), id = designRecordingChunkId(font);
    const host = recorder({ fonts: () => [{ id, bytes: font }] });
    const reply = await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames }, { record: host.record, recorder: RECORDER });
    expect(reply.recordings.map((r) => r.layers[0]!.typefaces)).toEqual([[id], [id]]);
    expect(reply.typefaces.map((t) => [t.id, t.bytes])).toEqual([[id, font.length]]);
    const sent = new Map(reply.chunks.map((chunk) => [chunk.id, Buffer.from(chunk.data, "base64")]));
    expect(Buffer.concat(reply.typefaces[0]!.chunks.map((chunk) => sent.get(chunk)!))).toEqual(font);
    const again = await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames, knownChunks: [...sent.keys()] }, { record: host.record, recorder: RECORDER });
    expect(again.typefaces.map((t) => t.id)).toEqual([id]);
    expect(again.chunks).toEqual([]);
  });

  it("fails a frame whose font data doesn't match the id the recorder gave it", async () => {
    const frames = await versions(["page-1/a.html"]);
    const host = recorder({ fonts: () => [{ id: "0".repeat(32), bytes: randomBytes(1_000) }] });
    const reply = await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames }, { record: host.record, recorder: RECORDER });
    expect(reply.recordings).toEqual([]);
    expect(reply.failed).toEqual([{ file: "page-1/a.html", error: "A font this frame uses could not be stored.", retryable: true }]);
  });
});
