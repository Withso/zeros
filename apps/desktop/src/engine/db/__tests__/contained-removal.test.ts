import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as contained from "../contained-removal.cjs";
import { refusal, removeContained, removeContainedAsync } from "../contained-removal.cjs";

const roots: string[] = [];
function scratch() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-contained-")));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SYNC = ["lstatSync", "statSync", "readdirSync", "rmSync", "rmdirSync", "unlinkSync", "openSync", "readFileSync", "readlinkSync", "realpathSync"] as const;
function spySync() {
  return SYNC.map((name) => vi.spyOn(fs, name));
}

describe("async contained removal", () => {
  it("agrees with the sync check and removes without any sync fs call", async () => {
    const root = scratch(), container = path.join(root, "store"), outside = scratch();
    fs.mkdirSync(path.join(container, "entry", "deep"), { recursive: true });
    fs.writeFileSync(path.join(container, "entry", "deep", "f"), "x");
    fs.symlinkSync(outside, path.join(container, "linked"));
    const refused = [
      path.join(container, "linked"), path.join(container, "missing"),
      path.join(container, "entry", "deep"), `${container}/../store/entry`, path.join(outside),
    ];
    const expected = refused.map((target) => refusal(target, { container, root }));
    expect(expected.every((reason) => reason !== null)).toBe(true);
    const spies = spySync();
    const actual = [];
    for (const target of refused) actual.push(await removeContainedAsync(target, { container, root }));
    expect(actual).toEqual(expected);
    expect(await removeContainedAsync(path.join(container, "entry"), { container, root })).toBe("removed");
    for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(fs.existsSync(path.join(container, "entry"))).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });
});

describe("the containment anchor", () => {
  it("refuses everything below a root that is itself a symlink", async () => {
    const real = scratch(), linkParent = scratch();
    const home = path.join(linkParent, "home");
    fs.symlinkSync(real, home);
    fs.mkdirSync(path.join(real, "store", "entry"), { recursive: true });
    const options = { container: path.join(home, "store"), root: home };
    expect(refusal(path.join(home, "store", "entry"), options)).toBe("symlink");
    expect(await removeContainedAsync(path.join(home, "store", "entry"), options)).toBe("symlink");
    expect(fs.existsSync(path.join(real, "store", "entry"))).toBe(true);
  });

  // Phase 4 review finding 6: a linked ancestor above a plain anchor was followed.
  it("refuses everything below a real root reached through a linked ancestor, before reading below it", async () => {
    const real = scratch(), linkParent = scratch();
    fs.mkdirSync(path.join(real, "home", "store", "entry"), { recursive: true });
    const linked = path.join(linkParent, "users");
    fs.symlinkSync(real, linked);
    const home = path.join(linked, "home");
    const target = path.join(home, "store", "entry");
    const options = { container: path.join(home, "store"), root: home };
    const lstat = vi.spyOn(fs, "lstatSync");
    expect(refusal(target, options)).toBe("linked ancestry");
    expect(lstat.mock.calls.some(([file]) => String(file).startsWith(`${home}${path.sep}`))).toBe(false);
    vi.restoreAllMocks();
    expect(removeContained(target, options)).toBe("linked ancestry");
    expect(await removeContainedAsync(target, options)).toBe("linked ancestry");
    expect(fs.existsSync(target)).toBe(true);
  });

  it("exports only what its callers use", () => {
    expect(Object.keys(contained).filter((key) => key !== "default").sort()).toEqual(["refusal", "removeContained", "removeContainedAsync"]);
  });
});
