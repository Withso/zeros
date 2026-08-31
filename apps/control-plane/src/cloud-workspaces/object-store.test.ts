import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileCloudWorkspaceObjectStore,
  MemoryCloudWorkspaceObjectStore,
  openWorkspaceObject,
  sealWorkspaceObject,
} from "./object-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("encrypted workspace object storage", () => {
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
    expect(await store.get("opaque/object")).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("publishes filesystem objects atomically and confines opaque keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    temporaryDirectories.push(root);
    const store = new FileCloudWorkspaceObjectStore(root);
    await expect(
      Promise.all([
        store.putIfAbsent("workspace/v1/org/blob", Uint8Array.from([1, 2, 3])),
        store.putIfAbsent("workspace/v1/org/blob", Uint8Array.from([4, 5, 6])),
      ]),
    ).resolves.toEqual(expect.arrayContaining(["created", "already_exists"]));
    const persisted = await readFile(
      path.join(root, "workspace", "v1", "org", "blob"),
    );
    expect([[1, 2, 3], [4, 5, 6]]).toContainEqual([...persisted]);
    await expect(store.get("../escape/object")).rejects.toThrow("invalid");
    await store.delete("workspace/v1/org/blob");
    await expect(store.get("workspace/v1/org/blob")).resolves.toBeNull();
  });

  it("does not follow a directory symlink outside the configured object root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "zeros-objects-outside-"));
    temporaryDirectories.push(root, outside);
    await mkdir(path.join(outside, "v1", "org"), { recursive: true });
    await symlink(outside, path.join(root, "workspace"), "dir");

    const store = new FileCloudWorkspaceObjectStore(root);
    await expect(
      store.putIfAbsent(
        "workspace/v1/org/blob",
        Uint8Array.from([1, 2, 3]),
      ),
    ).rejects.toThrow(/directory/i);
    await expect(access(path.join(outside, "v1", "org", "blob"))).rejects.toThrow();
  });
});
