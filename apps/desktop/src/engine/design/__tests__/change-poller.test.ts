import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesignChangePoller,
  designDirectorySignature,
  designSnapshotDirectory,
  noteDesignSnapshotDirectory,
} from "../change-poller";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function checkout(): Promise<{ root: string; frame: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-design-poller-"));
  roots.push(root);
  await mkdir(path.join(root, "App - Design", "page-1"), { recursive: true });
  const frame = path.join(root, "App - Design", "page-1", "home.html");
  await writeFile(frame, "<main>one</main>");
  return { root, frame };
}

/** Give a rewrite a distinct mtime even on coarse filesystems. */
async function rewrite(file: string, text: string, seconds: number): Promise<void> {
  await writeFile(file, text);
  const at = new Date(Date.now() + seconds * 1_000);
  await utimes(file, at, at);
}

describe("Design change poller", () => {
  it("reports a shown directory's edit once, after a baseline scan", async () => {
    const { root, frame } = await checkout();
    const changed = vi.fn();
    const poller = new DesignChangePoller({
      presentRoots: () => [root],
      directory: () => "App - Design",
      changed,
    });
    await poller.tick();
    await poller.tick();
    expect(changed).not.toHaveBeenCalled();
    await rewrite(frame, "<main>two</main>", 5);
    await poller.tick();
    await poller.tick();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith(path.resolve(root));
    // A new file and a new folder count; dotfiles and Zeros temp files do not.
    await writeFile(path.join(root, "App - Design", ".DS_Store"), "x");
    await writeFile(path.join(root, "App - Design", "page-1", "home.html.zeros-tmp"), "x");
    await poller.tick();
    expect(changed).toHaveBeenCalledTimes(1);
    await mkdir(path.join(root, "App - Design", "checkout"));
    await writeFile(path.join(root, "App - Design", "checkout", "pay.html"), "<main/>");
    await poller.tick();
    expect(changed).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("checks at once when a tool finishes, but only directories a tab shows", async () => {
    const { root, frame } = await checkout();
    const other = await checkout();
    const changed = vi.fn();
    const shown = [root];
    const poller = new DesignChangePoller({
      presentRoots: () => shown,
      directory: () => "App - Design",
      changed,
    });
    await poller.tick();
    await rewrite(frame, "<main>script</main>", 7);
    await poller.check(root);
    expect(changed).toHaveBeenCalledTimes(1);
    // Nobody shows the other checkout: no baseline, nothing to compare.
    await rewrite(other.frame, "<main>two</main>", 7);
    await poller.check(other.root);
    expect(changed).toHaveBeenCalledTimes(1);
    // A checkout that stops being shown is forgotten.
    shown.splice(0);
    await poller.tick();
    await rewrite(frame, "<main>later</main>", 9);
    await poller.check(root);
    expect(changed).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("absorbs a change another refresh already covered, without reporting it", async () => {
    const { root, frame } = await checkout();
    const changed = vi.fn();
    const poller = new DesignChangePoller({
      presentRoots: () => [root],
      directory: () => "App - Design",
      changed,
    });
    await poller.tick();
    // An agent's saved edit refreshed the canvas itself.
    await rewrite(frame, "<main>agent</main>", 4);
    await poller.absorb(root);
    await poller.tick();
    expect(changed).not.toHaveBeenCalled();
    // Later edits still report.
    await rewrite(frame, "<main>person</main>", 8);
    await poller.tick();
    expect(changed).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("never reports a directory switch, a missing directory or an oversized one", async () => {
    const { root, frame } = await checkout();
    await mkdir(path.join(root, "Other - Design"));
    await writeFile(path.join(root, "Other - Design", "a.html"), "<main/>");
    let directory = "App - Design";
    const changed = vi.fn();
    const poller = new DesignChangePoller(
      { presentRoots: () => [root], directory: () => directory, changed },
      { maxFiles: 1 },
    );
    await poller.tick();
    directory = "Other - Design";
    await poller.tick();
    expect(changed).not.toHaveBeenCalled();
    directory = "App - Design";
    await poller.tick();
    await writeFile(path.join(root, "App - Design", "page-1", "card.html"), "<main/>");
    await rewrite(frame, "<main>two</main>", 5);
    // Two files exceed maxFiles: left to the worktree watcher.
    await poller.tick();
    expect(changed).not.toHaveBeenCalled();
    directory = "Missing - Design";
    await poller.tick();
    expect(changed).not.toHaveBeenCalled();
    poller.stop();
  });

  it("signs file names, sizes and times, and remembers the directory each read resolved", async () => {
    const { root, frame } = await checkout();
    const directory = path.join(root, "App - Design");
    const first = await designDirectorySignature(directory);
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await designDirectorySignature(directory)).toBe(first);
    await rewrite(frame, "<main>two</main>", 3);
    expect(await designDirectorySignature(directory)).not.toBe(first);
    expect(await designDirectorySignature(path.join(root, "Missing"))).toBeNull();
    noteDesignSnapshotDirectory(root, "App - Design");
    expect(designSnapshotDirectory(`${root}/`)).toBe("App - Design");
  });
});
