import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readWorkspaceFile } from "../read-file";
import { readWorkspaceMediaRange } from "../file-media";

const roots: string[] = [];
function fixture(name: string, size: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-stream-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, name), "");
  fs.truncateSync(path.join(root, name), size);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each([false, true])("returns metadata for a 200 MB image/video without reading bytes (remote=%s)", remote => {
  for (const name of ["large.mp4", "large.png"]) {
    const root = fixture(name, 200_000_000);
    const read = vi.spyOn(fs, "readSync");
    const readFile = vi.spyOn(fs, "readFileSync");
    const result = readWorkspaceFile(root, name, { remote, includeVideo: true, streamMedia: true });
    expect(result).toMatchObject({ kind: name.endsWith("mp4") ? "video" : "image", bytes: 200_000_000,
      media: { mimeType: name.endsWith("mp4") ? "video/mp4" : "image/png", version: expect.any(String) } });
    expect(result.dataUrl).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(readWorkspaceFile(root, name, { includeVideo: true }).kind).toBe("too-large");
  }
});

it("refuses sources over 200 MB before reading and preserves path authorization", () => {
  const root = fixture("large.mp4", 200_000_001);
  const read = vi.spyOn(fs, "readSync");
  expect(readWorkspaceFile(root, "large.mp4", { includeVideo: true, streamMedia: true }))
    .toMatchObject({ kind: "too-large", bytes: 200_000_001 });
  expect(read).not.toHaveBeenCalled();
  fs.writeFileSync(path.join(root, ".env"), "fixture");
  fs.symlinkSync(".env", path.join(root, "secret.mp4"));
  expect(readWorkspaceFile(root, "secret.mp4", { remote: true, streamMedia: true, includeVideo: true }).kind).toBe("error");
});

it.each([false, true])("reads only the requested bytes and fences replaced media (remote=%s)", async remote => {
  const root = fixture("clip.mp4", 200_000_000), target = path.join(root, "clip.mp4");
  const file = fs.openSync(target, "r+");
  fs.writeSync(file, Buffer.from([1, 2, 3, 4]), 0, 4, 180_000_000); fs.closeSync(file);
  const replacementPath = path.join(root, "replacement.mp4");
  const replacement = fs.openSync(replacementPath, "wx", 0o600);
  try { fs.writeFileSync(replacement, "replacement"); }
  finally { fs.closeSync(replacement); }
  const version = readWorkspaceFile(root, "clip.mp4", { remote, includeVideo: true, streamMedia: true }).media!.version;
  const read = vi.spyOn(fs, "read"), readAll = vi.spyOn(fs, "readFileSync");
  const args = { path: "clip.mp4", version, offset: 180_000_000, length: 4 };
  expect(await readWorkspaceMediaRange(root, args, remote)).toEqual({ base64: "AQIDBA==", bytes: 4 });
  expect(read.mock.calls[0].slice(2, 5)).toEqual([0, 4, 180_000_000]);
  expect(readAll).not.toHaveBeenCalled();
  await expect(readWorkspaceMediaRange(root, { ...args, length: 1024 * 1024 + 1 }, remote)).rejects.toThrow();
  await expect(readWorkspaceMediaRange(root, { ...args, offset: 200_000_000 }, remote)).resolves.toEqual({ bytes: 0, base64: "" });
  // Replace atomically without reopening the pathname whose version was checked.
  fs.renameSync(replacementPath, target);
  await expect(readWorkspaceMediaRange(root, args, remote)).rejects.toThrow(/changed/);
  await expect(readWorkspaceMediaRange(root, { ...args, path: "../outside.mp4" }, remote)).rejects.toThrow();
  fs.mkdirSync(path.join(root, ".ssh")); fs.writeFileSync(path.join(root, ".ssh", "private.mp4"), "secret");
  fs.symlinkSync(".ssh/private.mp4", path.join(root, "shortcut.mp4"));
  await expect(readWorkspaceMediaRange(root, { ...args, path: "shortcut.mp4" }, true)).rejects.toThrow();
});
