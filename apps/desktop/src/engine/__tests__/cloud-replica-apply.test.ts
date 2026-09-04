import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CloudReplicaApplyEngine,
  normalizeCloudReplicaPath,
  type CloudReplicaApplyJournal,
  type CloudReplicaLocalEntry,
  type CloudReplicaLocalStateStore,
  type CloudReplicaMutation,
} from "../cloud-replica-apply";

class MemoryReplicaState implements CloudReplicaLocalStateStore {
  readonly entries = new Map<string, CloudReplicaLocalEntry>();
  readonly journals: CloudReplicaApplyJournal[] = [];
  readonly divergences: Array<{
    path: string;
    expectedSha256: string | null;
    observedSha256: string | null;
    cloudSha256: string | null;
  }> = [];

  entry(value: string) {
    return this.entries.get(value) ?? null;
  }

  entryByPortablePath(value: string) {
    return (
      [...this.entries.values()].find(
        (entry) => entry.portablePathKey === value,
      ) ?? null
    );
  }

  journal(value: CloudReplicaApplyJournal) {
    this.journals.push(value);
  }

  commitEntry(value: CloudReplicaLocalEntry) {
    this.entries.set(value.path, value);
  }

  commitDeletion(value: string) {
    this.entries.delete(value);
  }

  divergence(value: (typeof this.divergences)[number]) {
    this.divergences.push(value);
  }

  manifestSha256() {
    const hash = createHash("sha256");
    for (const entry of [...this.entries.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )) {
      hash.update(
        `${JSON.stringify([
          entry.path,
          entry.entryType,
          entry.mode,
          entry.contentSha256,
          entry.sizeBytes,
        ])}\n`,
        "utf8",
      );
    }
    return hash.digest("hex");
  }
}

const roots: string[] = [];

async function root(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "zeros-replica-test-"));
  roots.push(parent);
  return path.join(parent, "workspace");
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function upsert(
  relativePath: string,
  bytes: Buffer,
  revision = 1,
  sequence = 1,
): CloudReplicaMutation {
  return {
    revision,
    sequence,
    path: relativePath,
    operation: "upsert",
    entryType: "file",
    mode: 33188,
    blobId: `blob-${revision}-${sequence}`,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
}

describe("receive-only cloud replica filesystem apply", () => {
  it("atomically applies verified content and preserves a later local edit", async () => {
    const workspace = await root();
    const state = new MemoryReplicaState();
    const first = Buffer.from("cloud one\n", "utf8");
    const second = Buffer.from("cloud two\n", "utf8");
    const blobs = new Map([
      ["blob-1-1", first],
      ["blob-2-1", second],
    ]);
    const engine = new CloudReplicaApplyEngine(state, async (id) => {
      const value = blobs.get(id);
      if (!value) throw new Error("missing blob");
      return value;
    });
    await expect(
      engine.apply({
        replicaId: "replica-a",
        rootPath: workspace,
        fromRevision: 0,
        toRevision: 1,
        mutations: [upsert("src/value.ts", first)],
      }),
    ).resolves.toMatchObject({ applied: 1, toRevision: 1 });
    expect(await readFile(path.join(workspace, "src/value.ts"), "utf8")).toBe(
      "cloud one\n",
    );
    await writeFile(path.join(workspace, "src/value.ts"), "local edit\n");
    await expect(
      engine.apply({
        replicaId: "replica-a",
        rootPath: workspace,
        fromRevision: 1,
        toRevision: 2,
        mutations: [upsert("src/value.ts", second, 2)],
      }),
    ).rejects.toMatchObject({ code: "local_divergence" });
    expect(await readFile(path.join(workspace, "src/value.ts"), "utf8")).toBe(
      "local edit\n",
    );
    expect(state.divergences).toEqual([
      expect.objectContaining({
        path: "src/value.ts",
        expectedSha256: createHash("sha256").update(first).digest("hex"),
        observedSha256: createHash("sha256")
          .update("local edit\n")
          .digest("hex"),
      }),
    ]);
  });

  it("rejects parent symlink traversal and escaping cloud symlinks", async () => {
    const workspace = await root();
    const outside = path.join(path.dirname(workspace), "outside");
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(workspace, "src"));
    const bytes = Buffer.from("must stay inside\n", "utf8");
    const state = new MemoryReplicaState();
    const engine = new CloudReplicaApplyEngine(state, async () => bytes);
    await expect(
      engine.apply({
        replicaId: "replica-a",
        rootPath: workspace,
        fromRevision: 0,
        toRevision: 1,
        mutations: [upsert("src/escape.ts", bytes)],
      }),
    ).rejects.toMatchObject({ code: "path_rejected" });
    await expect(
      readFile(path.join(outside, "escape.ts")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    await rm(path.join(workspace, "src"));
    const linkBytes = Buffer.from("../../outside", "utf8");
    const link: CloudReplicaMutation = {
      ...upsert("safe-link", linkBytes),
      entryType: "symlink",
      mode: 40960,
    };
    await expect(
      new CloudReplicaApplyEngine(state, async () => linkBytes).apply({
        replicaId: "replica-a",
        rootPath: workspace,
        fromRevision: 0,
        toRevision: 1,
        mutations: [link],
      }),
    ).rejects.toMatchObject({ code: "symlink_rejected" });
  });

  it("rejects case/Unicode aliases and secret or engine-owned paths", async () => {
    for (const value of [
      ".git/config",
      ".zeros/state.db",
      ".zeros/settings.local.toml",
      ".zeros/runtime/engine.sock",
      ".env",
      "config/private.pem",
      "../escape",
      "decomposed/e\u0301.txt",
    ]) {
      expect(() => normalizeCloudReplicaPath(value)).toThrow();
    }
    expect(normalizeCloudReplicaPath(".zeros/settings.toml")).toBe(
      ".zeros/settings.toml",
    );
    const workspace = await root();
    const state = new MemoryReplicaState();
    const bytes = Buffer.from("same", "utf8");
    const engine = new CloudReplicaApplyEngine(state, async () => bytes);
    await expect(
      engine.apply({
        replicaId: "replica-a",
        rootPath: workspace,
        fromRevision: 0,
        toRevision: 1,
        mutations: [
          upsert("src/File.ts", bytes, 1, 1),
          upsert("src/file.ts", bytes, 1, 2),
        ],
      }),
    ).rejects.toMatchObject({ code: "path_rejected" });
    await expect(
      engine.apply({
        replicaId: "replica-a",
        rootPath: workspace,
        fromRevision: 0,
        toRevision: 1,
        mutations: [
          upsert("src", bytes, 1, 1),
          upsert("src/index.ts", bytes, 1, 2),
        ],
      }),
    ).rejects.toMatchObject({ code: "path_rejected" });
    await expect(readFile(path.join(workspace, "src"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(state.entries.size).toBe(0);
  });

  it("deletes only content that still matches the last cloud-applied hash", async () => {
    const workspace = await root();
    const state = new MemoryReplicaState();
    const bytes = Buffer.from("delete me", "utf8");
    const engine = new CloudReplicaApplyEngine(state, async () => bytes);
    await engine.apply({
      replicaId: "replica-a",
      rootPath: workspace,
      fromRevision: 0,
      toRevision: 1,
      mutations: [upsert("old.txt", bytes)],
    });
    await expect(
      engine.apply({
        replicaId: "replica-a",
        rootPath: workspace,
        fromRevision: 1,
        toRevision: 2,
        mutations: [
          {
            revision: 2,
            sequence: 1,
            path: "old.txt",
            operation: "delete",
            entryType: null,
            mode: null,
            blobId: null,
            contentSha256: null,
            sizeBytes: null,
          },
        ],
      }),
    ).resolves.toMatchObject({ applied: 1, toRevision: 2 });
    await expect(
      readFile(path.join(workspace, "old.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("replays a rename-or-delete crash without reporting false divergence", async () => {
    const workspace = await root();
    const state = new MemoryReplicaState();
    const first = Buffer.from("first", "utf8");
    const second = Buffer.from("second", "utf8");
    const engine = new CloudReplicaApplyEngine(state, async (id) =>
      id === "blob-1-1" ? first : second,
    );
    await engine.apply({
      replicaId: "replica-a",
      rootPath: workspace,
      fromRevision: 0,
      toRevision: 1,
      mutations: [upsert("value.txt", first)],
    });

    // Model a process death after rename but before the entry transaction.
    await writeFile(path.join(workspace, "value.txt"), second);
    await expect(
      engine.apply({
        replicaId: "replica-a",
        rootPath: workspace,
        fromRevision: 1,
        toRevision: 2,
        mutations: [upsert("value.txt", second, 2)],
      }),
    ).resolves.toMatchObject({ applied: 1, toRevision: 2 });
    expect(state.entry("value.txt")?.revision).toBe(2);

    // And the analogous death after unlink but before the SQLite deletion.
    await rm(path.join(workspace, "value.txt"));
    await expect(
      engine.apply({
        replicaId: "replica-a",
        rootPath: workspace,
        fromRevision: 2,
        toRevision: 3,
        mutations: [
          {
            revision: 3,
            sequence: 1,
            path: "value.txt",
            operation: "delete",
            entryType: null,
            mode: null,
            blobId: null,
            contentSha256: null,
            sizeBytes: null,
          },
        ],
      }),
    ).resolves.toMatchObject({ applied: 1, toRevision: 3 });
  });

  it("rejects reordered, replayed, or truncated revision pages", async () => {
    const workspace = await root();
    const bytes = Buffer.from("content", "utf8");
    const engine = new CloudReplicaApplyEngine(
      new MemoryReplicaState(),
      async () => bytes,
    );
    await expect(
      engine.apply({
        replicaId: "replica-a",
        rootPath: workspace,
        fromRevision: 1,
        toRevision: 2,
        mutations: [upsert("replayed.txt", bytes, 1)],
      }),
    ).rejects.toMatchObject({ code: "invalid_batch" });
    await expect(
      engine.apply({
        replicaId: "replica-a",
        rootPath: workspace,
        fromRevision: 1,
        toRevision: 3,
        mutations: [upsert("truncated.txt", bytes, 2)],
      }),
    ).rejects.toMatchObject({ code: "invalid_batch" });
    await expect(
      engine.apply({
        replicaId: "replica-a",
        rootPath: workspace,
        fromRevision: 1,
        toRevision: 2,
        mutations: [upsert("skipped-sequence.txt", bytes, 2, 2)],
      }),
    ).rejects.toMatchObject({ code: "invalid_batch" });
  });
});
