import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { designPrivateStorageDirectory } from "../metadata-storage";
import {
  currentDesignThumbnailPipeline,
  noteDesignThumbnailPipeline,
  readStoredDesignThumbnail,
  resetDesignThumbnailStoreForTests,
  settleDesignThumbnailStoreForTests,
  storeDesignThumbnail,
  sweepDesignThumbnails,
} from "../thumbnail-store";

/** A PNG header the store accepts, padded to `size` bytes. */
function picture(width: number, height: number, size = 64): Buffer {
  const bytes = Buffer.alloc(Math.max(size, 24));
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const v = (digit: string) => digit.repeat(24);
const light = { theme: null, colorScheme: "light" as const, maxDimension: 128 };

describe("Design thumbnail store", () => {
  let data: string;
  let workspace: string;
  beforeEach(async () => {
    resetDesignThumbnailStoreForTests();
    data = await mkdtemp(path.join(tmpdir(), "zeros-thumbnail-store-"));
    process.env.ZEROS_DATA_DIR = data;
    workspace = path.join(data, "checkout");
    await mkdir(workspace);
  });
  afterEach(async () => {
    await settleDesignThumbnailStoreForTests();
    resetDesignThumbnailStoreForTests();
    delete process.env.ZEROS_DATA_DIR;
    await rm(data, { recursive: true, force: true });
  });

  it("keeps one picture per frame and variant, the newest generation replacing the older", async () => {
    expect(await storeDesignThumbnail(workspace, "design_a", "frame_1", light, { sourceVersion: v("1"), pipeline: "thumbnails-1:x", bytes: picture(128, 80) })).toBe(true);
    expect(await storeDesignThumbnail(workspace, "design_a", "frame_1", { ...light, colorScheme: "dark" }, { sourceVersion: v("1"), pipeline: "thumbnails-1:x", bytes: picture(128, 80) })).toBe(true);
    expect(await storeDesignThumbnail(workspace, "design_a", "frame_1", light, { sourceVersion: v("2"), pipeline: "thumbnails-1:x", bytes: picture(128, 81) })).toBe(true);
    expect(await readStoredDesignThumbnail(workspace, "design_a", "frame_1", light)).toMatchObject({ sourceVersion: v("2"), pipeline: "thumbnails-1:x", width: 128, height: 81 });
    expect(await readStoredDesignThumbnail(workspace, "design_a", "frame_1", { ...light, colorScheme: "dark" })).toMatchObject({ sourceVersion: v("1") });
    expect(await readStoredDesignThumbnail(workspace, "design_a", "frame_1", { ...light, maxDimension: 64 })).toBeNull();
    expect(await readStoredDesignThumbnail(workspace, "design_b", "frame_1", light)).toBeNull();
    const folder = path.join(designPrivateStorageDirectory(workspace), "thumbnails", "design_a", "frame_1");
    expect((await readdir(folder)).sort()).toHaveLength(2);
  });

  it("refuses unsafe names, non-PNG bytes and folders that lead outside private storage", async () => {
    for (const [directory, frame] of [["../x", "frame_1"], ["design_a", "../frame"], ["design_a", "frame/1"], ["other", "frame_1"]])
      expect(await storeDesignThumbnail(workspace, directory!, frame!, light, { sourceVersion: v("1"), pipeline: "p", bytes: picture(1, 1) })).toBe(false);
    expect(await storeDesignThumbnail(workspace, "design_a", "frame_1", light, { sourceVersion: v("1"), pipeline: "p", bytes: Buffer.from("not a png") })).toBe(false);
    expect(await storeDesignThumbnail(workspace, "design_a", "frame_1", light, { sourceVersion: "bad", pipeline: "p", bytes: picture(1, 1) })).toBe(false);
    const outside = path.join(data, "outside");
    await mkdir(outside);
    const directory = path.join(designPrivateStorageDirectory(workspace), "thumbnails", "design_a");
    await mkdir(directory, { recursive: true });
    await symlink(outside, path.join(directory, "frame_2"));
    expect(await storeDesignThumbnail(workspace, "design_a", "frame_2", light, { sourceVersion: v("1"), pipeline: "p", bytes: picture(1, 1) })).toBe(false);
    expect(await readdir(outside)).toEqual([]);
    await writeFile(path.join(outside, `128-light-_~${v("1")}~${"0".repeat(16)}.png`), picture(1, 1));
    expect(await readStoredDesignThumbnail(workspace, "design_a", "frame_2", light)).toBeNull();
  });

  it("names the last pipeline a capture reported as current, across a restart", async () => {
    expect(await currentDesignThumbnailPipeline()).toEqual({ pipeline: null, exact: false });
    await storeDesignThumbnail(workspace, "design_a", "frame_1", light, { sourceVersion: v("1"), pipeline: "thumbnails-1:old", bytes: picture(1, 1) });
    await noteDesignThumbnailPipeline("thumbnails-1:new");
    await settleDesignThumbnailStoreForTests();
    resetDesignThumbnailStoreForTests();
    expect(await currentDesignThumbnailPipeline()).toEqual({ pipeline: "thumbnails-1:new", exact: false });
    expect(await readStoredDesignThumbnail(workspace, "design_a", "frame_1", light)).toMatchObject({ pipeline: "thumbnails-1:old" });
  });

  it("trims each workspace and the total, least recently used first, leaving other storage alone", async () => {
    const other = path.join(data, "other-checkout");
    await mkdir(other);
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    for (const [index, target] of [workspace, workspace, workspace, other].entries()) {
      await storeDesignThumbnail(target, "design_a", `frame_${index}`, light, { sourceVersion: v("1"), pipeline: "p", bytes: picture(1, 1, 1000) });
    }
    const file = (target: string, frame: string) => path.join(designPrivateStorageDirectory(target), "thumbnails", "design_a", frame);
    // frame_0 was read recently; frame_1 is the least recently used.
    for (const [frame, days] of [["frame_0", 1], ["frame_1", 9], ["frame_2", 5]] as const) {
      const folder = file(workspace, frame);
      const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      for (const name of await readdir(folder)) await utimes(path.join(folder, name), when, when);
    }
    const temporary = path.join(file(workspace, "frame_0"), `.${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.tmp`);
    await writeFile(temporary, "partial");
    await utimes(temporary, old, old);
    const unrelated = path.join(designPrivateStorageDirectory(workspace), "results.json");
    await writeFile(unrelated, "{}");
    await utimes(unrelated, old, old);
    expect(await sweepDesignThumbnails({ workspace: 2_500, total: 1_000_000 })).toEqual({ removed: 1, bytes: 1000 });
    expect(await readStoredDesignThumbnail(workspace, "design_a", "frame_1", light)).toBeNull();
    expect(await readStoredDesignThumbnail(workspace, "design_a", "frame_0", light)).not.toBeNull();
    expect(await readdir(file(workspace, "frame_0"))).toHaveLength(1);
    expect(await readdir(designPrivateStorageDirectory(workspace))).toContain("results.json");
    // The total is shared across workspaces.
    expect(await sweepDesignThumbnails({ workspace: 1_000_000, total: 2_000 })).toEqual({ removed: 1, bytes: 1000 });
    expect(await readStoredDesignThumbnail(workspace, "design_a", "frame_2", light)).toBeNull();
    expect(await readStoredDesignThumbnail(other, "design_a", "frame_3", light)).not.toBeNull();
  });
});
