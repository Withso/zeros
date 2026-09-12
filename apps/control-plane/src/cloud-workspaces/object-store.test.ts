import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileCloudWorkspaceObjectStore,
  MemoryCloudWorkspaceObjectStore,
  openWorkspaceObject,
  sealWorkspaceObject,
} from "./object-store.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

function versionedStagingShard(root: string, index: number): string {
  const bucket = Math.floor(index / 4_096).toString(16).padStart(2, "0");
  const shard = `${bucket}${(index % 4_096).toString(16).padStart(62, "0")}`;
  return path.join(root, ".uploads-v2", bucket, shard);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("encrypted workspace object storage", () => {
  const fileObjectKey =
    "workspace/v2/22222222-2222-4222-8222-222222222222/" +
    "11111111-1111-4111-8111-111111111111/k1";
  const binding = {
    blobId: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    keyVersion: 1,
  };

  it("round-trips exact binary bytes and binds them to tenant/blob identity", () => {
    const key = randomBytes(32).toString("base64url");
    const bytes = Buffer.from([0, 1, 2, 3, 255, 128, 42]);
    const sealed = sealWorkspaceObject(bytes, binding, key);
    expect(sealed.ciphertext).not.toEqual(bytes);
    expect(
      openWorkspaceObject(
        sealed.ciphertext,
        {
          ...sealed,
          plaintextBytes: bytes.length,
        },
        binding,
        key,
      ),
    ).toEqual(bytes);
    expect(() =>
      openWorkspaceObject(
        sealed.ciphertext,
        { ...sealed, plaintextBytes: bytes.length },
        {
          ...binding,
          organizationId: "33333333-3333-4333-8333-333333333333",
        },
        key,
      ),
    ).toThrow("invalid");
  });

  it("keeps put-if-absent atomic and returns defensive copies", async () => {
    const store = new MemoryCloudWorkspaceObjectStore();
    const first = Uint8Array.from([1, 2, 3]);
    expect(await store.putIfAbsent("opaque/object", first)).toBe("created");
    first[0] = 9;
    expect(await store.putIfAbsent("opaque/object", Uint8Array.from([4]))).toBe(
      "already_exists",
    );
    const loaded = await store.get("opaque/object");
    expect(loaded).toEqual(Uint8Array.from([1, 2, 3]));
    loaded![0] = 8;
    expect(await store.get("opaque/object")).toEqual(
      Uint8Array.from([1, 2, 3]),
    );
  });

  it("publishes filesystem objects atomically and confines opaque keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    const store = new FileCloudWorkspaceObjectStore(root);
    await expect(
      Promise.all([
        store.putIfAbsent(fileObjectKey, Uint8Array.from([1, 2, 3])),
        store.putIfAbsent(fileObjectKey, Uint8Array.from([4, 5, 6])),
      ]),
    ).resolves.toEqual(expect.arrayContaining(["created", "already_exists"]));
    const persisted = await readFile(
      path.join(root, ...fileObjectKey.split("/")),
    );
    expect([
      [1, 2, 3],
      [4, 5, 6],
    ]).toContainEqual([...persisted]);
    await expect(store.get("../escape/object")).rejects.toThrow("invalid");
    await store.delete(fileObjectKey);
    await expect(store.get(fileObjectKey)).resolves.toBeNull();
  });

  it("does not follow a directory symlink outside the configured object root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "zeros-objects-outside-"),
    );
    temporaryDirectories.push(root, outside);
    await mkdir(path.join(outside, "v2"), { recursive: true });
    await symlink(outside, path.join(root, "workspace"), "dir");

    const store = new FileCloudWorkspaceObjectStore(root);
    await expect(
      store.putIfAbsent(fileObjectKey, Uint8Array.from([1, 2, 3])),
    ).rejects.toThrow(/directory/i);
    await expect(
      access(path.join(outside, ...fileObjectKey.split("/").slice(1))),
    ).rejects.toThrow();
  });

  it("rejects replacement of the configured object-store root", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(parent);
    const root = path.join(parent, "active");
    await mkdir(root, { mode: 0o700 });
    const store = new FileCloudWorkspaceObjectStore(root);
    await store.putIfAbsent(fileObjectKey, Buffer.from("original root"));
    await rename(root, path.join(parent, "replaced"));
    await mkdir(root, { mode: 0o700 });

    await expect(store.get(fileObjectKey)).rejects.toThrow(/changed/i);
  });

  it("rejects an existing object-store root readable by another identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    await chmod(root, 0o750);

    const store = new FileCloudWorkspaceObjectStore(root);
    await expect(store.get(fileObjectKey)).rejects.toThrow(/permissions/i);
  });

  it("persists an immutable deletion fence across restarts and ordinary deletes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    const store = new FileCloudWorkspaceObjectStore(root);
    await expect(
      store.putIfAbsent(fileObjectKey, Uint8Array.from([1, 2, 3])),
    ).resolves.toBe("created");

    await store.deleteAndFence(fileObjectKey);
    await store.delete(fileObjectKey);

    const restarted = new FileCloudWorkspaceObjectStore(root);
    await expect(restarted.get(fileObjectKey)).resolves.toBeNull();
    await expect(
      restarted.putIfAbsent(fileObjectKey, Uint8Array.from([4, 5, 6])),
    ).rejects.toThrow(/permanently fenced/i);
    await expect(
      readFile(
        path.join(
          root,
          ...fileObjectKey.split("/"),
          ".zeros-object-deletion-fence-v1",
        ),
        "utf8",
      ),
    ).resolves.toBe("zeros-object-deletion-fence-v1\n");
  });

  it("repairs a torn deletion-fence marker without reopening the key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    const target = path.join(root, ...fileObjectKey.split("/"));
    await mkdir(target, { recursive: true });
    await writeFile(
      path.join(target, ".zeros-object-deletion-fence-v1"),
      "torn",
      { mode: 0o600 },
    );

    const store = new FileCloudWorkspaceObjectStore(root);
    await expect(store.deleteAndFence(fileObjectKey)).resolves.toBeUndefined();
    await expect(store.get(fileObjectKey)).resolves.toBeNull();
    await expect(
      store.putIfAbsent(fileObjectKey, Uint8Array.from([1])),
    ).rejects.toThrow(/permanently fenced/i);
  });

  it("bounds filesystem keys to the non-prefixing immutable object schema", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    const store = new FileCloudWorkspaceObjectStore(root);

    await expect(
      store.putIfAbsent(`${fileObjectKey}/child`, Uint8Array.from([1])),
    ).rejects.toThrow(/invalid/i);
    await expect(
      store.putIfAbsent("workspace/v2/org/blob/k1", Uint8Array.from([1])),
    ).rejects.toThrow(/invalid/i);
  });

  it("sweeps only aged, private abandoned upload staging files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    const staging = path.join(
      root,
      ".uploads-v1",
      createHash("sha256").update(fileObjectKey, "utf8").digest("hex"),
    );
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const abandoned = path.join(
      staging,
      `upload-${process.pid}-${randomUUID()}`,
    );
    const recent = path.join(staging, `upload-${process.pid}-${randomUUID()}`);
    const unrelated = path.join(staging, "operator-note");
    await Promise.all([
      writeFile(abandoned, "abandoned", { mode: 0o600 }),
      writeFile(recent, "recent", { mode: 0o600 }),
      writeFile(unrelated, "leave me", { mode: 0o600 }),
    ]);
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    await utimes(abandoned, old, old);

    const store = new FileCloudWorkspaceObjectStore(root);
    await expect(
      store.sweepAbandonedUploads({ olderThanMs: 24 * 60 * 60_000 }),
    ).resolves.toBe(1);
    await expect(access(abandoned)).rejects.toThrow();
    await expect(stat(recent)).resolves.toMatchObject({ size: 6 });
    await expect(stat(unrelated)).resolves.toMatchObject({ size: 8 });
  });

  it("removes empty per-key staging shards after successful publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    const store = new FileCloudWorkspaceObjectStore(root);

    await expect(
      store.putIfAbsent(fileObjectKey, Uint8Array.from([1, 2, 3])),
    ).resolves.toBe("created");
    await expect(
      readdir(path.join(root, ".uploads-v2")),
    ).resolves.toEqual([]);
  });

  it("recovers a published object whose staging hard link survived a crash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    const target = path.join(root, ...fileObjectKey.split("/"));
    const staging = path.join(
      root,
      ".uploads-v1",
      createHash("sha256").update(fileObjectKey, "utf8").digest("hex"),
    );
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const staged = path.join(staging, `upload-${process.pid}-${randomUUID()}`);
    await writeFile(staged, Buffer.from("published-before-crash"), {
      mode: 0o600,
    });
    await link(staged, target);

    const store = new FileCloudWorkspaceObjectStore(root);
    await expect(store.get(fileObjectKey)).resolves.toEqual(
      Buffer.from("published-before-crash"),
    );
    await expect(
      store.putIfAbsent(fileObjectKey, Buffer.from("replacement")),
    ).resolves.toBe("already_exists");
  });

  it("converges concurrent deletion fences while staging entries disappear", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    const first = new FileCloudWorkspaceObjectStore(root);
    const second = new FileCloudWorkspaceObjectStore(root);
    await first.putIfAbsent(fileObjectKey, Buffer.from("fence race"));
    const staging = path.join(
      root,
      ".uploads-v1",
      createHash("sha256").update(fileObjectKey, "utf8").digest("hex"),
    );
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await Promise.all(
      Array.from({ length: 32 }, () =>
        writeFile(
          path.join(staging, `upload-${process.pid}-${randomUUID()}`),
          "abandoned",
          { mode: 0o600 },
        ),
      ),
    );

    await expect(
      Promise.all([
        first.deleteAndFence(fileObjectKey),
        second.deleteAndFence(fileObjectKey),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    await expect(first.get(fileObjectKey)).resolves.toBeNull();
  });

  it("replaces an unsafe FIFO leaf with a bounded permanent fence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    const target = path.join(root, ...fileObjectKey.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await execFileAsync("mkfifo", [target]);

    const store = new FileCloudWorkspaceObjectStore(root);
    await expect(store.deleteAndFence(fileObjectKey)).resolves.toBeUndefined();
    await expect(store.get(fileObjectKey)).resolves.toBeNull();
  });

  it("rejects an unsafe FIFO leaf without blocking a read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    const target = path.join(root, ...fileObjectKey.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await execFileAsync("mkfifo", [target]);

    const store = new FileCloudWorkspaceObjectStore(root);
    await expect(store.get(fileObjectKey)).rejects.toThrow(/unsafe/i);
  });

  it("never follows a final object symlink outside the configured root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "zeros-objects-outside-"),
    );
    temporaryDirectories.push(root, outside);
    const target = path.join(root, ...fileObjectKey.split("/"));
    const outsideFile = path.join(outside, "object");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(outsideFile, "outside", { mode: 0o600 });
    await symlink(outsideFile, target, "file");

    const store = new FileCloudWorkspaceObjectStore(root);
    await expect(store.get(fileObjectKey)).rejects.toThrow();
    await expect(
      store.putIfAbsent(fileObjectKey, Buffer.from("replacement")),
    ).rejects.toThrow(/unsafe/i);
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside");

    await expect(store.deleteAndFence(fileObjectKey)).resolves.toBeUndefined();
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside");
    await expect(store.get(fileObjectKey)).resolves.toBeNull();
  });

  it("makes concurrent abandoned-upload sweeps idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    const staging = path.join(
      root,
      ".uploads-v1",
      createHash("sha256").update(fileObjectKey, "utf8").digest("hex"),
    );
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const uploads = Array.from(
      { length: 32 },
      () => path.join(staging, `upload-${process.pid}-${randomUUID()}`),
    );
    await Promise.all(
      uploads.map((upload) => writeFile(upload, "abandoned", { mode: 0o600 })),
    );
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    await Promise.all(uploads.map((upload) => utimes(upload, old, old)));
    const first = new FileCloudWorkspaceObjectStore(root);
    const second = new FileCloudWorkspaceObjectStore(root);

    const removed = await Promise.all([
      first.sweepAbandonedUploads({ olderThanMs: 24 * 60 * 60_000 }),
      second.sweepAbandonedUploads({ olderThanMs: 24 * 60 * 60_000 }),
    ]);
    expect(removed[0]! + removed[1]!).toBe(32);
  });

  it("sweeps past more than one bounded page of historical empty shards", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    const staging = path.join(root, ".uploads-v2");
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const shards = Array.from({ length: 4_097 }, (_, index) =>
      versionedStagingShard(root, index),
    );
    for (let offset = 0; offset < shards.length; offset += 256) {
      await Promise.all(
        shards
          .slice(offset, offset + 256)
          .map((shard) => mkdir(shard, { recursive: true, mode: 0o700 })),
      );
    }
    const store = new FileCloudWorkspaceObjectStore(root);

    await expect(store.sweepAbandonedUploads()).resolves.toBe(0);
    await expect(store.sweepAbandonedUploads()).resolves.toBe(0);
    await expect(readdir(staging)).resolves.toEqual([]);
  });

  it("does not starve an aged upload behind a full page of recent shards", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    const staging = path.join(root, ".uploads-v2");
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const shards = Array.from({ length: 4_097 }, (_, index) =>
      versionedStagingShard(root, index),
    );
    for (let offset = 0; offset < shards.length; offset += 128) {
      await Promise.all(
        shards.slice(offset, offset + 128).map(async (shard, index) => {
          await mkdir(shard, { recursive: true, mode: 0o700 });
          await writeFile(
            path.join(
              shard,
              `upload-${process.pid}-${randomUUID()}`,
            ),
            offset + index === shards.length - 1 ? "aged" : "recent",
            { mode: 0o600 },
          );
        }),
      );
    }
    const agedUpload = path.join(
      shards.at(-1)!,
      (await readdir(shards.at(-1)!))[0]!,
    );
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    await utimes(agedUpload, old, old);
    const store = new FileCloudWorkspaceObjectStore(root);

    await store.sweepAbandonedUploads({
      olderThanMs: 24 * 60 * 60_000,
      maxEntries: 100,
    });
    await store.sweepAbandonedUploads({
      olderThanMs: 24 * 60 * 60_000,
      maxEntries: 100,
    });
    await store.sweepAbandonedUploads({
      olderThanMs: 24 * 60 * 60_000,
      maxEntries: 100,
    });

    await expect(access(agedUpload)).rejects.toThrow();
  });
});
