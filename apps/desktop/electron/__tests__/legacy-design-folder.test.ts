import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeEmptyLegacyDesignFolder } from "../legacy-design-folder";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("the obsolete `design workspaces` folder (12.zz)", () => {
  it("goes only when nothing is in it (empty folders and Finder's .DS_Store), and never when anything else is", async () => {
    const base = await mkdtemp(join(tmpdir(), "design-folder-")); roots.push(base);
    const empty = join(base, "empty", "design workspaces");
    await mkdir(join(empty, "repo", "ws"), { recursive: true }); await writeFile(join(empty, ".DS_Store"), "");
    expect(await removeEmptyLegacyDesignFolder(empty)).toBe(true);
    expect(await readdir(join(base, "empty"))).toEqual([]);
    const kept = join(base, "kept", "design workspaces");
    await mkdir(join(kept, "repo", "ws"), { recursive: true }); await writeFile(join(kept, "repo", "ws", "notes.md"), "mine");
    await mkdir(join(kept, "other"), { recursive: true });
    expect(await removeEmptyLegacyDesignFolder(kept)).toBe(false);
    expect((await readdir(join(kept, "repo", "ws")))).toEqual(["notes.md"]);
    expect(await removeEmptyLegacyDesignFolder(join(base, "missing", "design workspaces"))).toBe(false);
  });
});
