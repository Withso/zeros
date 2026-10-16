import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractRuntimeDeb } from "../cloud-workspace-validation/runtime-bundle/system-assets";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const directory = { name: "./", type: "directory", mode: "0755" };
const file = { name: "./file", data: "fixture" };
const symlink = (name: string, target: string) => ({ name, target, type: "symlink", mode: "0777" });
const cases = [
  // The six independent review cases, retained as generated synthetic .debs.
  { name: "ordinary", accepted: true, members: [directory, file] },
  { name: "root-world-writable", accepted: false, members: [{ ...directory, mode: "0777" }, file] },
  { name: "chained-link-escape", accepted: false, members: [directory, symlink("./a", "."), symlink("./escape", "a/../outside-marker")] },
  { name: "direct-link-escape", accepted: false, members: [symlink("./escape", "../outside-marker")] },
  { name: "relative-parent-file", accepted: false, members: [{ name: "../outside-marker", data: "must not write" }] },
  { name: "link-as-parent", accepted: false, members: [symlink("./dir", "."), { name: "./dir/child", data: "must not write" }] },
  { name: "root-unowned", accepted: false, members: [{ ...directory, uid: 1000 }, file] },
  { name: "root-foreign-group", accepted: false, members: [{ ...directory, gid: 1000 }, file] },
  { name: "root-setgid", accepted: false, members: [{ ...directory, mode: "2755" }, file] },
  { name: "root-duplicate", accepted: false, members: [directory, { ...directory, name: "." }, file] },
  { name: "link-cycle", accepted: false, members: [symlink("./a", "b"), symlink("./b", "a")] },
  { name: "direct-contained-link", accepted: true, members: [directory, file, symlink("./link", "file")] },
];

describe("Debian payload extraction preflight", () => {
  it.each(cases)("validates $name before creating the destination", async ({ accepted, members }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-extract-case-")); roots.push(root);
    const archive = path.join(root, "fixture.deb"), destination = path.join(root, "extracted");
    execFileSync("python3", [path.resolve("scripts/__tests__/fixtures/runtime-system-assets/make-extract-case.py"), archive],
      { input: JSON.stringify(members), stdio: ["pipe", "pipe", "pipe"] });
    const extraction = extractRuntimeDeb(archive, destination, { cwd: root, env: { PATH: process.env.PATH } });
    if (accepted) {
      await extraction;
      expect((await lstat(destination)).mode & 0o7777).toBe(0o755);
      expect(await readFile(path.join(destination, "file"), "utf8")).toBe("fixture");
    } else {
      await expect(extraction).rejects.toThrow(/asset_deb/);
      await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(lstat(path.join(root, "outside-marker"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
