import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { FileCloudWorkspaceObjectStore } from "./object-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, lstat: vi.fn(original.lstat), unlink: vi.fn(original.unlink) };
});

it.each(["delete", "sweep", "unsafe replacement", "persistent zero links"] as const)(
  "converges when %s observes an upload inode unlinked during its stat",
  async (action) => {
    const original = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-upload-race-"));
    const key =
      "workspace/v2/22222222-2222-4222-8222-222222222222/" +
      "11111111-1111-4111-8111-111111111111/k1";
    try {
      const store = new FileCloudWorkspaceObjectStore(root);
      await store.putIfAbsent(key, Buffer.from("original"));
      const shard = path.join(
        await realpath(root),
        ".uploads-v1",
        createHash("sha256").update(key).digest("hex"),
      );
      await mkdir(shard, { recursive: true, mode: 0o700 });
      const candidate = path.join(shard, `upload-${process.pid}-${randomUUID()}`);
      await writeFile(candidate, "abandoned", { mode: 0o600 });
      let observedUnlinkedInode = false;
      let removedSnapshot: Awaited<ReturnType<typeof original.stat>> | undefined;
      vi.mocked(lstat).mockImplementation(async (filename, options) => {
        if (String(filename) === candidate && !observedUnlinkedInode) {
          observedUnlinkedInode = true;
          // Linux can resolve the inode before another deleter unlinks it,
          // then copy its now-zero link count into the stat result.
          const handle = await original.open(candidate, "r");
          try {
            await original.unlink(candidate);
            const removed = await handle.stat();
            expect(removed.nlink).toBe(0);
            removedSnapshot = removed;
            if (action === "unsafe replacement") {
              await original.symlink("/outside-the-object-store", candidate);
            }
            return removed;
          } finally {
            await handle.close();
          }
        }
        if (String(filename) === candidate && action === "persistent zero links") {
          return removedSnapshot!;
        }
        return original.lstat(filename, options);
      });
      if (action === "unsafe replacement" || action === "persistent zero links") {
        await expect(store.deleteAndFence(key)).rejects.toThrow(
          action === "unsafe replacement" ? /staging file is unsafe/ : /did not converge/,
        );
        await expect(store.get(key)).resolves.toEqual(Buffer.from("original"));
      } else if (action === "delete") {
        await expect(store.deleteAndFence(key)).resolves.toBeUndefined();
        await expect(store.get(key)).resolves.toBeNull();
      } else {
        await expect(store.sweepAbandonedUploads({ olderThanMs: 60_000, maxEntries: 10 })).resolves.toBe(0);
        await expect(store.get(key)).resolves.toEqual(Buffer.from("original"));
      }
      expect(observedUnlinkedInode).toBe(true);
    } finally {
      vi.mocked(lstat).mockImplementation(original.lstat);
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("preserves a deletion fence published after another deleter inspected the old file", async () => {
  const original = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-fence-race-"));
  const key =
    "workspace/v2/22222222-2222-4222-8222-222222222222/" +
    "11111111-1111-4111-8111-111111111111/k1";
  const firstAtUnlink = Promise.withResolvers<void>();
  const secondAtUnlink = Promise.withResolvers<void>();
  const firstFinished = Promise.withResolvers<void>();
  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  try {
    const one = new FileCloudWorkspaceObjectStore(root);
    const two = new FileCloudWorkspaceObjectStore(root);
    await one.putIfAbsent(key, Buffer.from("original"));
    const target = path.join(await realpath(root), ...key.split("/"));
    let removals = 0;
    vi.mocked(unlink).mockImplementation(async (candidate) => {
      if (String(candidate) === target) {
        removals += 1;
        if (removals === 1) {
          firstAtUnlink.resolve();
          await secondAtUnlink.promise;
        } else if (removals === 2) {
          secondAtUnlink.resolve();
          await firstFinished.promise;
        }
      }
      // Use the real filesystem error when the file becomes a directory.
      return original.unlink(candidate);
    });
    first = one.deleteAndFence(key).finally(() => firstFinished.resolve());
    await firstAtUnlink.promise;
    second = two.deleteAndFence(key);
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(removals).toBe(2);
    await expect(one.get(key)).resolves.toBeNull();
    await expect(two.putIfAbsent(key, Buffer.from("resurrection"))).rejects.toThrow(
      /permanently fenced/,
    );
    expect(
      await readFile(path.join(target, ".zeros-object-deletion-fence-v1")),
    ).not.toHaveLength(0);
  } finally {
    secondAtUnlink.resolve();
    firstFinished.resolve();
    await Promise.allSettled([first, second]);
    vi.mocked(unlink).mockImplementation(original.unlink);
    await rm(root, { recursive: true, force: true });
  }
});
