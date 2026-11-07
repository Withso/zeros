import { mkdir, mkdtemp, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localWorktreeNativeWatcher, watchWorktreeRecursively } from "../recursive-watch";
import type { WatchHostClient, WorktreeWatcher } from "../watch-host-client";

describe("how a Local engine watches worktree content", () => {
  it("uses its watch host, else one recursive watch per root on macOS, else Chokidar", () => {
    const watched: string[] = [];
    const host = { watch: (root: string) => { watched.push(root); return {} as WorktreeWatcher; } } as unknown as WatchHostClient;
    localWorktreeNativeWatcher(host, "darwin")!("/repo");
    expect(watched).toEqual(["/repo"]);
    expect(localWorktreeNativeWatcher(null, "darwin")).toBe(watchWorktreeRecursively);
    expect(localWorktreeNativeWatcher(null, "linux")).toBeUndefined();
  });
});

describe("one recursive watch for a worktree root", () => {
  let root: string;
  let watcher: WorktreeWatcher;
  let events: Array<[string, string]>;
  const saw = (event: string, file: string) => events.some(([kind, filePath]) => kind === event && filePath === path.join(root, file));

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-recursive-watch-"));
    await mkdir(path.join(root, "kept"), { recursive: true });
    events = [];
    watcher = watchWorktreeRecursively(root);
    watcher.on("all", (event, filePath) => events.push([event, filePath]));
    await new Promise<void>((resolve) => watcher.once("ready", resolve));
  });
  afterEach(async () => {
    await watcher.close();
    await rm(root, { recursive: true, force: true });
  });

  it("reports files and folders as the native host does, ignoring Git and dependency trees", async () => {
    await writeFile(path.join(root, "a.txt"), "1");
    await vi.waitFor(() => expect(saw("add", "a.txt")).toBe(true), { timeout: 5_000 });
    await writeFile(path.join(root, "a.txt"), "2");
    await vi.waitFor(() => expect(saw("change", "a.txt")).toBe(true), { timeout: 5_000 });
    await mkdir(path.join(root, "page"));
    await vi.waitFor(() => expect(saw("addDir", "page")).toBe(true), { timeout: 5_000 });
    await writeFile(path.join(root, "page/frame.html"), "<p>x</p>");
    await vi.waitFor(() => expect(saw("add", "page/frame.html")).toBe(true), { timeout: 5_000 });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".git/HEAD"), "ref: refs/heads/main\n");
    await mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(path.join(root, "node_modules/pkg/index.js"), "x");
    await unlink(path.join(root, "a.txt"));
    await vi.waitFor(() => expect(saw("unlink", "a.txt")).toBe(true), { timeout: 5_000 });
    // A folder that existed before the watch is known, so removing it is a folder removal.
    await rmdir(path.join(root, "kept"));
    await vi.waitFor(() => expect(saw("unlinkDir", "kept")).toBe(true), { timeout: 5_000 });
    expect(events.some(([, filePath]) => /[\\/](?:\.git|node_modules)(?:[\\/]|$)/.test(filePath))).toBe(false);
  });

  it("stops reporting once closed", async () => {
    await watcher.close();
    await writeFile(path.join(root, "late.txt"), "x");
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual([]);
  });
});
