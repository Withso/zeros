import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readWorkspaceFile } from "../read-file";
import { writeWorkspaceFile } from "../write-file";

const roots: string[] = [];
const root = () => { const value = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-files-boundary-"))); roots.push(value); return value; };
afterEach(() => { vi.restoreAllMocks(); for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

it("does not read through an ancestor swapped after canonical path validation", () => {
  const workspace = root(), outside = root(), directory = path.join(workspace, "nested");
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "file.txt"), "allowed"); fs.writeFileSync(path.join(outside, "file.txt"), "secret-canary");
  const realpath = fs.realpathSync;
  let swapped = false;
  vi.spyOn(fs, "realpathSync").mockImplementation(((name: fs.PathLike, options?: unknown) => {
    const result = realpath(name, options as never);
    if (String(name) === path.join(directory, "file.txt") && !swapped) {
      swapped = true; fs.renameSync(directory, `${directory}-saved`); fs.symlinkSync(outside, directory);
    }
    return result;
  }) as typeof fs.realpathSync);
  expect(readWorkspaceFile(workspace, "nested/file.txt").content).not.toBe("secret-canary");
});

it.each([
  { name: "clip.mp4", streamMedia: false },
  { name: "clip.mp4", streamMedia: true },
  { name: "image.png", streamMedia: true },
])("keeps the approved root for $name (streamMedia=$streamMedia) when it is replaced during inspection", ({ name, streamMedia }) => {
  const workspace = root(), outside = root(), saved = `${workspace}-saved`;
  fs.writeFileSync(path.join(workspace, name), "allowed");
  fs.writeFileSync(path.join(outside, name), "outside-canary");
  const fstat = fs.fstatSync;
  let swapped = false;
  vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: unknown) => {
    const info = fstat(fd, options as never);
    if (info.isFile() && !swapped) {
      swapped = true;
      fs.renameSync(workspace, saved); roots.push(saved);
      fs.symlinkSync(outside, workspace);
    }
    return info;
  }) as typeof fs.fstatSync);
  const result = readWorkspaceFile(workspace, name, { canonicalRoot: workspace, includeVideo: true, streamMedia });
  expect(swapped).toBe(true);
  if (streamMedia) expect(result.kind).toBe("error");
  else expect(result.dataUrl).not.toBe(`data:video/mp4;base64,${Buffer.from("outside-canary").toString("base64")}`);
});

it("pins the publication directory instead of writing through a replaced ancestor", () => {
  const workspace = root(), outside = root(), directory = path.join(workspace, "nested");
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "file.txt"), "old"); fs.writeFileSync(path.join(outside, "file.txt"), "canary");
  const rename = fs.renameSync;
  let swapped = false;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (!swapped) { swapped = true; rename(directory, `${directory}-saved`); fs.symlinkSync(outside, directory); }
    return rename(from, to);
  });
  writeWorkspaceFile(workspace, "nested/file.txt", "new");
  expect(fs.readFileSync(path.join(outside, "file.txt"), "utf8")).toBe("canary");
});
