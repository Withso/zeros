import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDirectoryNoFollow } from "../no-follow";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("opens a directory by walking every component from the root without following any link", async () => {
  const root = await mkdtemp(join(tmpdir(), "zeros-no-follow-")); roots.push(root);
  await mkdir(join(root, "home", ".local", "share", "zeros"), { recursive: true });
  const held = await openDirectoryNoFollow(join(root, "home", ".local", "share", "zeros"));
  expect(held).toBeDefined();
  await held!.close();
  expect(await openDirectoryNoFollow(join(root, "home", ".missing", "x"))).toBeUndefined();
  await mkdir(join(root, "elsewhere", "share", "zeros"), { recursive: true });
  await symlink(join(root, "elsewhere"), join(root, "home", ".linked"));
  await expect(openDirectoryNoFollow(join(root, "home", ".linked", "share", "zeros"))).rejects.toThrow();
  await expect(openDirectoryNoFollow(join(root, "home", ".linked"))).rejects.toThrow();
  await expect(openDirectoryNoFollow("relative/path")).rejects.toThrow();
});
