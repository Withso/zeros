import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  canonicalJson,
  createManifest,
  inventoryTree,
  parseManifest,
  sha256,
  validateFiles,
  type ManifestEntry,
} from "../cloud-workspace-validation/runtime-bundle/manifest";
import {
  tarHeader,
  writeRuntimeArchive,
} from "../cloud-workspace-validation/runtime-bundle/archive";
import { verifyRuntimeArchive } from "../cloud-workspace-validation/runtime-bundle/verify";

const temporary: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-bundle-unit-"));
  temporary.push(directory);
  const root = path.join(directory, "root");
  await mkdir(path.join(root, "bin"), { recursive: true, mode: 0o755 });
  await writeFile(path.join(root, "bin/node"), "fixture node\n", {
    mode: 0o555,
  });
  await symlink("node", path.join(root, "bin/alias"));
  const manifest = createManifest(
    {
      agents: {
        claude: { cli: "2.1.288", sdk: "0.3.288" },
        codex: { package: "0.160.0" },
        cursor: { sdk: "1.0.35" },
      },
      source: { commit: "a".repeat(40), lockfileSha256: "b".repeat(64) },
      engineProtocolVersion: 20,
    },
    await inventoryTree(root),
  );
  return { directory, root, manifest, bytes: canonicalJson(manifest) };
}
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("runtime manifest", () => {
  it("canonicalizes every object while retaining array order, with no newline", () => {
    expect(
      canonicalJson({ z: [{ z: 1, a: "é" }], a: { z: 2, b: 1 } }).toString(),
    ).toBe('{"a":{"b":1,"z":2},"z":[{"a":"é","z":1}]}');
    expect(() => canonicalJson({ invalid: undefined })).toThrow();
    expect(() => canonicalJson({ invalid: Infinity })).toThrow();
  });

  it("sorts paths by UTF-8 bytes, inventories links, and excludes its own manifest", async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, "manifest.json"), "not payload");
    await writeFile(path.join(root, "Z"), "Z", { mode: 0o444 });
    await writeFile(path.join(root, "a"), "a", { mode: 0o444 });
    const entries = await inventoryTree(root);
    expect(entries.map((entry) => entry.path)).toEqual([
      "Z",
      "a",
      "bin",
      "bin/alias",
      "bin/node",
    ]);
    expect(entries.find((entry) => entry.path === "bin/alias")).toEqual({
      path: "bin/alias",
      type: "symlink",
      target: "node",
    });
    expect(entries.find((entry) => entry.path === "bin/node")).toEqual({
      path: "bin/node",
      type: "file",
      size: 13,
      sha256: sha256(Buffer.from("fixture node\n")),
      mode: "0555",
    });
  });

  it.each([
    "/absolute",
    "../escape",
    "a/../b",
    "./file",
    "a//b",
    "a/",
    "a\\b",
    "a\0b",
    "manifest.json",
  ])("rejects inventory path %j", (name) => {
    expect(() =>
      validateFiles([{ path: name, type: "dir", mode: "0755" }]),
    ).toThrow();
  });

  it.each(["4755", "2755", "1755", "0775", "0757", "755", "0888"])(
    "rejects unsafe/noncanonical mode %s",
    (mode) => {
      expect(() =>
        validateFiles([{ path: "bin", type: "dir", mode }]),
      ).toThrow();
    },
  );

  it("rejects duplicates, unsorted entries and children below a symlink", () => {
    const dir: ManifestEntry = { path: "a", type: "dir", mode: "0755" };
    expect(() => validateFiles([dir, dir])).toThrow();
    expect(() => validateFiles([{ ...dir, path: "z" }, dir])).toThrow();
    expect(() =>
      validateFiles([
        dir,
        { path: "b", type: "symlink", target: "a" },
        { ...dir, path: "b/child" },
      ]),
    ).toThrow();
    expect(() => validateFiles([{ ...dir, path: "missing/child" }])).toThrow();
  });

  it("checks lexical escapes, chained escapes, cycles and dangling links", () => {
    const dir: ManifestEntry = { path: "a", type: "dir", mode: "0755" };
    for (const target of ["/etc/passwd", "../../etc", "missing", "link"]) {
      expect(() =>
        validateFiles([dir, { path: "a/link", type: "symlink", target }]),
      ).toThrow();
    }
    // Lexically inside R, but traversing 'back' first escapes R.
    expect(() =>
      validateFiles([
        dir,
        { path: "a/back", type: "symlink", target: ".." },
        { path: "escape", type: "symlink", target: "a/back/../outside" },
      ]),
    ).toThrow();
    expect(() =>
      validateFiles([
        { path: "a", type: "symlink", target: "b" },
        { path: "b", type: "symlink", target: "a" },
      ]),
    ).toThrow();
    expect(() =>
      validateFiles([
        dir,
        { path: "a/back", type: "symlink", target: ".." },
        { path: "b", type: "symlink", target: "a/back/a" },
      ]),
    ).not.toThrow();
  });

  it("rejects hardlinked and writable staged files", async () => {
    const { root } = await fixture();
    await link(path.join(root, "bin/node"), path.join(root, "bin/hard"));
    await expect(inventoryTree(root)).rejects.toThrow(/hard_link/);
    await rm(path.join(root, "bin/hard"));
    await chmod(path.join(root, "bin/node"), 0o666);
    await expect(inventoryTree(root)).rejects.toThrow(/file_mode/);
  });

  it("verifies canonical raw bytes, rejects duplicate JSON keys and unknown fields", async () => {
    const { bytes, manifest } = await fixture();
    expect(parseManifest(bytes)).toEqual(manifest);
    expect(() => parseManifest(Buffer.from(bytes.toString() + "\n"))).toThrow();
    expect(() =>
      parseManifest(
        Buffer.from(
          bytes.toString().replace('"schema":', '"schema":"bad","schema":'),
        ),
      ),
    ).toThrow();
    expect(() =>
      parseManifest(canonicalJson({ ...manifest, runtimeId: "recursive" })),
    ).toThrow();
  });
});

describe("runtime archive", () => {
  it("writes identical gzip bytes across roots and normalizes every header", async () => {
    const first = await fixture();
    const second = await fixture();
    const one = path.join(first.directory, "one.tar.gz");
    const two = path.join(second.directory, "two.tar.gz");
    await writeRuntimeArchive(first.root, first.bytes, one);
    await writeRuntimeArchive(second.root, second.bytes, two);
    const archive = await readFile(one);
    expect(archive.equals(await readFile(two))).toBe(true);
    expect(archive.subarray(0, 10)).toEqual(
      Buffer.from([31, 139, 8, 0, 0, 0, 0, 0, 2, 3]),
    );
    const tar = gunzipSync(archive);
    expect(tar.subarray(0, 13).toString()).toBe("manifest.json");
    expect(tar.subarray(512, 512 + first.bytes.length)).toEqual(first.bytes);
    for (let offset = 0; tar[offset] !== 0; ) {
      const header = tar.subarray(offset, offset + 512);
      for (const [start, length] of [
        [108, 8],
        [116, 8],
        [136, 12],
      ]) {
        expect(
          parseInt(header.subarray(start, start + length).toString(), 8),
        ).toBe(0);
      }
      expect(header.subarray(265, 329).every((byte) => byte === 0)).toBe(true);
      const size = parseInt(header.subarray(124, 136).toString(), 8);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    const verified = await verifyRuntimeArchive({
      archivePath: one,
      manifestBytes: first.bytes,
      extractTo: path.join(first.directory, "relocated"),
    });
    expect(verified.descriptor.runtimeId).toBe("r1-" + sha256(first.bytes));
    expect(verified.descriptor.expandedBytes).toBe(13);
  });

  it("uses only local path/linkpath PAX records for long UTF-8 names and targets", async () => {
    const { root, directory, manifest } = await fixture();
    const long = "worker/" + "package-".repeat(16) + "/" + "é".repeat(60);
    await mkdir(path.join(root, path.dirname(long)), { recursive: true });
    await writeFile(path.join(root, long), "long", { mode: 0o444 });
    await symlink(long, path.join(root, "long-link"));
    const bytes = canonicalJson({
      ...manifest,
      files: await inventoryTree(root),
    });
    const output = path.join(directory, "pax.tar.gz");
    await writeRuntimeArchive(root, bytes, output);
    const verified = await verifyRuntimeArchive({
      archivePath: output,
      manifestBytes: bytes,
      extractTo: path.join(directory, "extract"),
    });
    expect(verified.manifest.files.some((entry) => entry.path === long)).toBe(
      true,
    );
    expect(
      await readFile(path.join(directory, "extract/long-link"), "utf8"),
    ).toBe("long");
  });

  it("refuses changed payloads at archive write and at independent readback", async () => {
    const { root, bytes, directory } = await fixture();
    await chmod(path.join(root, "bin/node"), 0o644);
    await writeFile(path.join(root, "bin/node"), "changed bytes");
    await chmod(path.join(root, "bin/node"), 0o555);
    await expect(
      writeRuntimeArchive(root, bytes, path.join(directory, "changed.tar.gz")),
    ).rejects.toThrow();
    await writeFile(
      path.join(directory, "bad.tar.gz"),
      gzipSync(
        Buffer.concat([
          tarHeader({
            path: "manifest.json",
            type: "file",
            mode: "0444",
            size: bytes.length,
          }),
          bytes,
          Buffer.alloc((512 - (bytes.length % 512)) % 512),
          Buffer.alloc(1024),
        ]),
        { level: 9 },
      ),
    );
    await expect(
      verifyRuntimeArchive({
        archivePath: path.join(directory, "bad.tar.gz"),
        manifestBytes: bytes,
      }),
    ).rejects.toThrow(/file_inventory/);
  });

  it.each([
    { field: 0, value: "../escape", check: "archive_paths" },
    { field: 156, value: "1", check: "archive_member_type" },
    { field: 156, value: "g", check: "archive_member_type" },
    { field: 100, value: "0004755", check: "file_mode" },
    { field: 108, value: "0000001", check: "tar_metadata" },
  ])(
    "rejects unsafe tar metadata ($check) before extraction",
    async ({ field, value, check }) => {
      const { root, directory, bytes } = await fixture();
      const output = path.join(directory, "original.tar.gz");
      await writeRuntimeArchive(root, bytes, output);
      const tar = gunzipSync(await readFile(output));
      tar.fill(0, field, field + (field === 0 ? 100 : value.length));
      tar.write(value, field);
      tar.fill(32, 148, 156);
      const checksum = tar
        .subarray(0, 512)
        .reduce((sum, byte) => sum + byte, 0);
      tar.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
      const bad = path.join(directory, "unsafe.tar.gz");
      await writeFile(bad, gzipSync(tar, { level: 9 }));
      await expect(
        verifyRuntimeArchive({ archivePath: bad, manifestBytes: bytes }),
      ).rejects.toThrow(check);
    },
  );
});
