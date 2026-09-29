import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareCloudImageFileLayout } from "../cloud-workspace-validation/sandbox/prepare-cloud-image-files.mjs";

let root: string;
let layout: { root: string; repository: string; engineFilesRoot: string; attachmentTemporaryRoot: string };
const owners = { root: process.getuid!(), engine: process.getuid!(), worker: process.getuid!() };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-image-files-"));
  fs.chmodSync(root, 0o755);
  layout = { root, engineFilesRoot: path.join(root, "files"), repository: path.join(root, "files/workspace"),
    attachmentTemporaryRoot: path.join(root, "files/attachment-staging") };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("moves the image seed recoverably and leaves its repository contents intact", () => {
  fs.mkdirSync(path.join(root, "workspace"));
  fs.chmodSync(path.join(root, "workspace"), 0o775);
  fs.writeFileSync(path.join(root, "workspace/keep"), "seed contents");
  prepareCloudImageFileLayout(layout, owners);
  expect(fs.readFileSync(path.join(layout.repository, "keep"), "utf8")).toBe("seed contents");
  expect(fs.existsSync(path.join(root, "workspace"))).toBe(false);
  expect(fs.statSync(layout.attachmentTemporaryRoot).mode & 0o777).toBe(0o700);
  expect(fs.readdirSync(layout.engineFilesRoot).sort()).toEqual([
    "attachment-staging", "home", "managed-settings", "state", "workspace",
  ]);
  prepareCloudImageFileLayout(layout, owners);
  expect(fs.readFileSync(path.join(layout.repository, "keep"), "utf8")).toBe("seed contents");
});

it("refuses ambiguous old and new repositories without replacing either", () => {
  fs.mkdirSync(path.join(root, "workspace"));
  fs.mkdirSync(layout.repository, { recursive: true });
  fs.writeFileSync(path.join(root, "workspace/keep"), "old");
  fs.writeFileSync(path.join(layout.repository, "keep"), "new");
  expect(() => prepareCloudImageFileLayout(layout, owners)).toThrow(/ambiguous/i);
  expect(fs.readFileSync(path.join(root, "workspace/keep"), "utf8")).toBe("old");
  expect(fs.readFileSync(path.join(layout.repository, "keep"), "utf8")).toBe("new");
});

it.each(["symlink", "writable", "unexpected-file", "populated-mount"])("refuses unsafe projection: %s", (kind) => {
  fs.mkdirSync(path.join(root, "workspace"));
  if (kind === "symlink") {
    fs.mkdirSync(path.join(root, "other"));
    fs.symlinkSync(path.join(root, "other"), layout.engineFilesRoot);
  } else {
    fs.mkdirSync(layout.engineFilesRoot, { mode: 0o755 });
    if (kind === "writable") fs.chmodSync(layout.engineFilesRoot, 0o777);
    if (kind === "unexpected-file") fs.writeFileSync(path.join(layout.engineFilesRoot, "authority"), "private");
    if (kind === "populated-mount") {
      fs.mkdirSync(path.join(layout.engineFilesRoot, "state"));
      fs.writeFileSync(path.join(layout.engineFilesRoot, "state/authority"), "private");
    }
  }
  expect(() => prepareCloudImageFileLayout(layout, owners)).toThrow(/unsafe|unexpected/i);
});
