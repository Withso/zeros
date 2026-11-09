import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkDesignRecording } from "../recording-chunks";
import { readDesignRecordingChunk, readStoredDesignRecording, storeDesignRecording } from "../recording-store";

const version = (c: string) => c.repeat(24);
function bytesFrom(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = x & 0xff; }
  return out;
}

describe("recording store", () => {
  let data: string;
  let workspace: string;
  beforeEach(async () => {
    data = await mkdtemp(path.join(tmpdir(), "zeros-recording-store-"));
    workspace = path.join(data, "workspace");
    process.env.ZEROS_DATA_DIR = path.join(data, "engine");
  });
  afterEach(async () => {
    delete process.env.ZEROS_DATA_DIR;
    await rm(data, { recursive: true, force: true });
  });
  const recording = (sourceVersion: string, bytes: Uint8Array) => ({ sourceVersion, pipeline: "recordings-1:electron-43/chromium-150/skp",
    width: 1440, height: 900, scale: 2, layers: [{ x: 0, y: 0, width: 2880, height: 1800, bytes }] });

  it("stores a recording as chunks and reads it back exactly", async () => {
    const bytes = bytesFrom(3, 250_000);
    const stored = await storeDesignRecording(workspace, "design_1", "frame_1", null, recording(version("a"), bytes));
    expect(stored?.layers[0]?.chunks).toEqual(chunkDesignRecording(bytes).map((c) => c.id));
    const read = await readStoredDesignRecording(workspace, "design_1", "frame_1", null);
    expect(read).toEqual(stored);
    const parts = await Promise.all(read!.layers[0]!.chunks.map((id) => readDesignRecordingChunk(id)));
    expect(Buffer.concat(parts.map((part) => part!))).toEqual(Buffer.from(bytes));
  });

  it("replaces older generations of a frame in one theme and answers a named version only with it", async () => {
    await storeDesignRecording(workspace, "design_1", "frame_1", "dark", recording(version("a"), bytesFrom(1, 10_000)));
    await storeDesignRecording(workspace, "design_1", "frame_1", "dark", recording(version("b"), bytesFrom(2, 10_000)));
    await storeDesignRecording(workspace, "design_1", "frame_1", null, recording(version("c"), bytesFrom(4, 10_000)));
    expect((await readStoredDesignRecording(workspace, "design_1", "frame_1", "dark"))?.sourceVersion).toBe(version("b"));
    expect(await readStoredDesignRecording(workspace, "design_1", "frame_1", "dark", { sourceVersion: version("a") })).toBeNull();
    expect(await readStoredDesignRecording(workspace, "design_1", "frame_1", "dark", { pipeline: "another" })).toBeNull();
    expect((await readStoredDesignRecording(workspace, "design_1", "frame_1", null))?.sourceVersion).toBe(version("c"));
  });

  it("stores bytes shared by recordings once", async () => {
    const font = bytesFrom(9, 300_000);
    const a = new Uint8Array([...bytesFrom(5, 3_000), ...font]);
    const b = new Uint8Array([...bytesFrom(6, 7_000), ...font]);
    const first = await storeDesignRecording(workspace, "design_1", "frame_a", null, recording(version("a"), a));
    const second = await storeDesignRecording(workspace, "design_1", "frame_b", null, recording(version("b"), b));
    const ids = new Set(first!.layers[0]!.chunks);
    expect(second!.layers[0]!.chunks.filter((id) => ids.has(id)).length).toBeGreaterThan(25);
    let files = 0;
    const chunks = path.join(process.env.ZEROS_DATA_DIR!, "design-storage", "recording-chunks");
    for (const shard of await readdir(chunks)) files += (await readdir(path.join(chunks, shard))).length;
    expect(files).toBe(new Set([...first!.layers[0]!.chunks, ...second!.layers[0]!.chunks]).size);
  });

  it("treats a corrupted chunk or an id it doesn't hold as missing", async () => {
    const stored = await storeDesignRecording(workspace, "design_1", "frame_1", null, recording(version("a"), bytesFrom(8, 20_000)));
    const id = stored!.layers[0]!.chunks[0]!;
    const file = path.join(process.env.ZEROS_DATA_DIR!, "design-storage", "recording-chunks", id.slice(0, 2), id);
    await writeFile(file, "tampered");
    expect(await readDesignRecordingChunk(id)).toBeNull();
    expect(await readDesignRecordingChunk("0".repeat(32))).toBeNull();
    expect(await readDesignRecordingChunk("../../etc/passwd")).toBeNull();
  });

  it("refuses malformed identities and reads nothing through a planted link", async () => {
    expect(await storeDesignRecording(workspace, "../x", "frame_1", null, recording(version("a"), bytesFrom(1, 10)))).toBeNull();
    expect(await storeDesignRecording(workspace, "design_1", "frame_1", "Bad Theme", recording(version("a"), bytesFrom(1, 10)))).toBeNull();
    expect(await storeDesignRecording(workspace, "design_1", "frame_1", null, recording("short", bytesFrom(1, 10)))).toBeNull();
    await storeDesignRecording(workspace, "design_1", "frame_1", null, recording(version("a"), bytesFrom(1, 10_000)));
    const outside = await mkdtemp(path.join(tmpdir(), "zeros-recording-outside-"));
    try {
      const storage = path.join(process.env.ZEROS_DATA_DIR!, "design-storage");
      const workspaceKey = (await readdir(storage)).find((name) => name !== "recording-chunks")!;
      const folder = path.join(storage, workspaceKey, "recordings", "design_1");
      await rm(path.join(folder, "frame_2"), { recursive: true, force: true });
      await symlink(outside, path.join(folder, "frame_2"));
      expect(await readStoredDesignRecording(workspace, "design_1", "frame_2", null)).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
