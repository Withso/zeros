import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCloudGitExecPath } from "../cloud-workspace-validation/sandbox/prepare-cloud-git.mjs";
import { cloudRuntimeAssetEnvironment } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-assets.mjs";
import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-git-exec-")); roots.push(root);
  const runtime = testCloudRuntime(), foreign = new Set<string>();
  const physical = (file: string) => path.join(root, file);
  const virtual = (file: string) => file === root ? "/" : file.slice(root.length);
  const file = (name: string, value = "synthetic executable", mode = 0o555) => {
    fs.mkdirSync(path.dirname(physical(name)), { recursive: true, mode: 0o755 }); fs.writeFileSync(physical(name), value, { mode });
  };
  file(`${runtime.binRoot}/git-lfs`);
  for (const name of ["git", "git-sh-setup", "git-remote-https", "git-lfs", "mergetools/tool"])
    file(`/usr/lib/git-core/${name}`);
  fs.mkdirSync(physical("/run/zeros"), { recursive: true, mode: 0o755 });
  // Root ownership is modeled only within this disposable filesystem. All
  // real filesystem types, modes, link resolution and publication still run.
  const filesystem = {
    lstatSync: (name: string) => Object.assign(Object.create(fs.lstatSync(physical(name))), { uid: foreign.has(name) ? 10003 : 0 }),
    realpathSync: (name: string) => virtual(fs.realpathSync(physical(name))),
    readdirSync: (name: string) => fs.readdirSync(physical(name)),
    readlinkSync: (name: string) => virtual(fs.readlinkSync(physical(name))),
    mkdirSync: (name: string, options: fs.MakeDirectoryOptions) => fs.mkdirSync(physical(name), options),
    mkdtempSync: (prefix: string) => virtual(fs.mkdtempSync(physical(prefix))),
    symlinkSync: (target: string, name: string) => fs.symlinkSync(physical(target), physical(name)),
    chmodSync: (name: string, mode: number) => fs.chmodSync(physical(name), mode),
    renameSync: (from: string, to: string) => fs.renameSync(physical(from), physical(to)),
    rmSync: (name: string, options: fs.RmOptions) => fs.rmSync(physical(name), options),
  };
  const prepare = (selected = runtime) => prepareCloudGitExecPath(selected, { filesystem, gitDirectory: "/usr/lib/git-core" });
  return { runtime, root, physical, file, foreign, filesystem, prepare };
}

describe("physical runtime Git exec selection", () => {
  it("creates a searchable owned parent under the private host umask without changing that umask", () => {
    const f = fixture(), previous = process.umask(0o077);
    try {
      const selected = f.prepare();
      expect(process.umask()).toBe(0o077);
      expect(fs.lstatSync(f.physical(path.dirname(selected))).mode & 0o7777).toBe(0o755);
      expect(fs.lstatSync(f.physical(selected)).mode & 0o7777).toBe(0o555);
    } finally { process.umask(previous); }
  });

  it("repairs and reuses an interrupted safe parent under the private host umask", () => {
    const f = fixture(), parent = "/opt/zeros-infra/.git-exec";
    fs.mkdirSync(f.physical(parent), { mode: 0o700 });
    const inode = fs.lstatSync(f.physical(parent)).ino, previous = process.umask(0o077);
    try {
      const selected = f.prepare();
      expect(fs.lstatSync(f.physical(parent)).mode & 0o7777).toBe(0o755);
      fs.chmodSync(f.physical(parent), 0o700);
      expect(f.prepare()).toBe(selected);
      expect(fs.lstatSync(f.physical(parent)).ino).toBe(inode);
      expect(fs.lstatSync(f.physical(parent)).mode & 0o7777).toBe(0o755);
      expect(process.umask()).toBe(0o077);
    } finally { process.umask(previous); }
  });

  it.each(["foreign", "writable", "aliased", "regular-file", "special-mode", "writable-ancestor"])(
    "refuses a %s parent before changing any permissions", change => {
      const f = fixture(), parent = "/opt/zeros-infra/.git-exec";
      if (change === "regular-file") f.file(parent);
      else if (change === "aliased") {
        fs.mkdirSync(f.physical("/run/zeros/elsewhere"));
        f.filesystem.symlinkSync("/run/zeros/elsewhere", parent);
      } else fs.mkdirSync(f.physical(parent), { mode: 0o700 });
      if (change === "foreign") f.foreign.add(parent);
      if (change === "writable") fs.chmodSync(f.physical(parent), 0o777);
      if (change === "special-mode") fs.chmodSync(f.physical(parent), 0o1700);
      if (change === "writable-ancestor") fs.chmodSync(f.physical("/opt/zeros-infra"), 0o777);
      const chmod = vi.spyOn(f.filesystem, "chmodSync");
      expect(() => f.prepare()).toThrow(/projection/);
      expect(chmod).not.toHaveBeenCalled();
    });

  it("rechecks the searchable parent mode before publishing links", () => {
    const f = fixture(), parent = "/opt/zeros-infra/.git-exec", chmod = f.filesystem.chmodSync;
    fs.mkdirSync(f.physical(parent), { mode: 0o700 });
    vi.spyOn(f.filesystem, "chmodSync").mockImplementation((name, mode) => {
      if (name !== parent) chmod(name, mode);
    });
    expect(() => f.prepare()).toThrow(/projection/);
    expect(fs.readdirSync(f.physical(parent))).toEqual([]);
  });

  it("preserves native commands/libraries, replaces stock LFS, and reuses only the exact protected projection", () => {
    const f = fixture(), selected = f.prepare();
    expect(selected).toBe(cloudRuntimeAssetEnvironment(f.runtime).GIT_EXEC_PATH);
    expect(f.filesystem.readlinkSync(`${selected}/git-lfs`)).toBe(`${f.runtime.binRoot}/git-lfs`);
    for (const name of ["git", "git-sh-setup", "git-remote-https", "mergetools"])
      expect(f.filesystem.readlinkSync(`${selected}/${name}`)).toBe(`/usr/lib/git-core/${name}`);
    const inode = fs.lstatSync(f.physical(selected)).ino;
    expect(f.prepare()).toBe(selected);
    expect(fs.lstatSync(f.physical(selected)).ino).toBe(inode);
    expect(fs.readdirSync(f.physical("/opt/zeros-infra/.git-exec"))).toEqual([f.runtime.runtimeId]);
  });

  it("keeps each resident's immutable pin when another runtime is selected", () => {
    const f = fixture(), original = f.prepare(), runtimeId = `r1-${"b".repeat(64)}`;
    const root = `/opt/zeros-infra/${runtimeId}`, next = { ...f.runtime, runtimeId, root, binRoot: `${root}/bin`, workerRoot: `${root}/worker` };
    f.file(`${next.binRoot}/git-lfs`); const selected = f.prepare(next);
    expect(selected).not.toBe(original);
    expect(f.filesystem.readlinkSync(`${original}/git-lfs`)).toBe(`${f.runtime.binRoot}/git-lfs`);
    expect(f.filesystem.readlinkSync(`${selected}/git-lfs`)).toBe(`${next.binRoot}/git-lfs`);
  });

  it("repairs missing derived links in the final directory without renaming or replacing it", () => {
    const f = fixture(), selected = f.prepare();
    const inode = fs.lstatSync(f.physical(selected)).ino;
    // Model an interrupted root publication, before its final read-only mode.
    fs.chmodSync(f.physical(selected), 0o700);
    for (const name of ["git-lfs", "git-remote-https"]) fs.unlinkSync(f.physical(`${selected}/${name}`));
    f.filesystem.renameSync = () => { throw new Error("Directory rename is not restore-safe"); };
    expect(f.prepare()).toBe(selected);
    expect(fs.lstatSync(f.physical(selected)).ino).toBe(inode);
    expect(fs.lstatSync(f.physical(selected)).mode & 0o777).toBe(0o555);
    expect(f.filesystem.readlinkSync(`${selected}/git-lfs`)).toBe(`${f.runtime.binRoot}/git-lfs`);
    expect(f.filesystem.readlinkSync(`${selected}/git-remote-https`)).toBe("/usr/lib/git-core/git-remote-https");
  });

  it("refuses changed links before repairing a partial derived directory", () => {
    const f = fixture(), selected = f.prepare();
    fs.chmodSync(f.physical(selected), 0o700);
    for (const name of ["git-lfs", "git-remote-https"]) fs.unlinkSync(f.physical(`${selected}/${name}`));
    f.filesystem.symlinkSync("/usr/lib/git-core/git-lfs", `${selected}/git-lfs`);
    expect(() => f.prepare()).toThrow(/projection/);
    expect(fs.existsSync(f.physical(`${selected}/git-remote-https`))).toBe(false);
  });

  it.each(["missing-lfs", "writable-lfs", "foreign-lfs", "writable-stock", "foreign-stock", "source-escape", "missing-https"])(
    "refuses %s without publishing a fallback", change => {
      const f = fixture(), lfs = `${f.runtime.binRoot}/git-lfs`, stock = "/usr/lib/git-core/git";
      if (change === "missing-lfs") fs.unlinkSync(f.physical(lfs));
      if (change === "writable-lfs") fs.chmodSync(f.physical(lfs), 0o777);
      if (change === "foreign-lfs") f.foreign.add(lfs);
      if (change === "writable-stock") fs.chmodSync(f.physical(stock), 0o777);
      if (change === "foreign-stock") f.foreign.add(stock);
      if (change === "missing-https") fs.unlinkSync(f.physical("/usr/lib/git-core/git-remote-https"));
      if (change === "source-escape") {
        f.file("/home/user/tool"); fs.unlinkSync(f.physical(stock)); f.filesystem.symlinkSync("/home/user/tool", stock);
      }
      expect(() => f.prepare()).toThrow();
      expect(fs.existsSync(f.physical(`/opt/zeros-infra/.git-exec/${f.runtime.runtimeId}`))).toBe(false);
    });

  it.each(["extra", "wrong-link", "regular-file", "writable-directory", "foreign-directory", "aliased-parent"])(
    "refuses a cached projection with %s", change => {
      const f = fixture(), selected = f.prepare();
      fs.chmodSync(f.physical(selected), 0o755);
      if (change === "extra") f.file(`${selected}/extra`);
      if (["wrong-link", "regular-file"].includes(change)) {
        fs.unlinkSync(f.physical(`${selected}/git-lfs`));
        if (change === "wrong-link") f.filesystem.symlinkSync("/usr/lib/git-core/git-lfs", `${selected}/git-lfs`);
        else f.file(`${selected}/git-lfs`);
      }
      if (change === "writable-directory") fs.chmodSync(f.physical(selected), 0o777);
      if (change === "foreign-directory") f.foreign.add(selected);
      if (change === "aliased-parent") {
        fs.renameSync(f.physical("/opt/zeros-infra/.git-exec"), f.physical("/run/zeros/elsewhere"));
        f.filesystem.symlinkSync("/run/zeros/elsewhere", "/opt/zeros-infra/.git-exec");
      }
      expect(() => f.prepare()).toThrow(/projection/);
    });

  it("refuses a facade, foreign Git installation, and legacy profile", () => {
    const f = fixture();
    expect(() => f.prepare({ ...f.runtime, root: "/opt/zeros/current" })).toThrow(/projection/);
    expect(() => prepareCloudGitExecPath(f.runtime, { filesystem: f.filesystem, gitDirectory: "/home/user/git-core" })).toThrow(/projection/);
    expect(() => f.prepare({ ...f.runtime, profile: "legacy" } as typeof f.runtime)).toThrow(/projection/);
    expect(cloudRuntimeAssetEnvironment({ profile: "legacy", workerRoot: "/legacy" })).toEqual({});
  });
});
