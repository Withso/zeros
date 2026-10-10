import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stageRipgrep } from "../stage-ripgrep.mjs";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "zeros-stage-rg-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("product ripgrep staging", () => {
  it("copies exact provider search bytes atomically with updater-compatible executable mode", async () => {
    const source = path.join(root, "pinned-rg");
    const output = path.join(root, "binaries", "rg");
    const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0xff]);
    await writeFile(source, bytes, { mode: 0o555 });
    await stageRipgrep({ source, output });
    expect(await readFile(output)).toEqual(bytes);
    expect((await stat(output)).mode & 0o777).toBe(0o755);
    expect(await readdir(path.dirname(output))).toEqual(["rg"]);
    expect((await stat(source)).mode & 0o777).toBe(0o555);
  });

  it("replaces an old artifact without requiring any sandbox runtime", async () => {
    const source = path.join(root, "rg"), output = path.join(root, "out", "rg");
    await mkdir(path.dirname(output));
    await writeFile(output, "old");
    await writeFile(source, "new", { mode: 0o755 });
    await stageRipgrep({ source, output });
    expect(await readFile(output, "utf8")).toBe("new");
  });

  it("keeps an existing output when the pinned source is unavailable", async () => {
    const output = path.join(root, "rg");
    await writeFile(output, "retained");
    await expect(stageRipgrep({ source: path.join(root, "missing"), output })).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("retained");
    expect(await readdir(root)).toEqual(["rg"]);
  });

  it("rejects a non-executable pinned artifact before publication", async () => {
    const source = path.join(root, "not-executable"), output = path.join(root, "out");
    await writeFile(source, "bytes");
    await chmod(source, 0o644);
    await expect(stageRipgrep({ source, output })).rejects.toThrow(/executable/);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
