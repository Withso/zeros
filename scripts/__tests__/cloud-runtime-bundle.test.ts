import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  canonicalJson,
  createManifest,
  descriptorSchema,
  inventoryTree,
  parseManifest,
  sha256,
  validateFiles,
  validPath,
  type ManifestEntry,
} from "../cloud-workspace-validation/runtime-bundle/manifest";
import {
  archiveByteLimit,
  tarHeader,
  writeRuntimeArchive,
} from "../cloud-workspace-validation/runtime-bundle/archive";
import { verifyRuntimeArchive } from "../cloud-workspace-validation/runtime-bundle/verify";
import {
  buildEnvironment,
  elfVersionNeeds,
  versionAtMost,
} from "../cloud-workspace-validation/runtime-bundle/toolchain";

const temporary: string[] = [];

describe("Linux toolchain contract", () => {
  it("compares numeric GLIBC versions and inspects needs instead of definitions", () => {
    expect(versionAtMost("2.9", "2.39")).toBe(true);
    expect(versionAtMost("2.39", "2.39")).toBe(true);
    expect(versionAtMost("2.40", "2.39")).toBe(false);
    expect(versionAtMost("2.39.1", "2.39")).toBe(false);
    const needs = elfVersionNeeds(
      "Version definition section '.gnu.version_d'\nName: GLIBC_2.99\nVersion needs section '.gnu.version_r'\nName: GLIBC_2.28\nName: GLIBCXX_3.4.29\nName: CXXABI_1.3\nName: GLIBC_2.3\nName: GLIBC_2.28\n",
    );
    expect(needs).toEqual({
      glibc: ["2.3", "2.28"],
      glibcxx: ["3.4.29"],
      cxxabi: ["1.3"],
    });
  });
  it("uses a fresh HOME, an explicit cloud capability and an environment allowlist", () => {
    const key = "BUNDLE_TEST_SECRET";
    const previous = process.env[key];
    process.env[key] = "synthetic-fixture";
    try {
      const environment = buildEnvironment("/temporary-build");
      expect(environment.HOME).toBe("/temporary-build/home");
      expect(environment.ZEROS_CLOUD_WORKSPACES_ENABLED).toBe("true");
      expect(environment.SOURCE_DATE_EPOCH).toBe("0");
      for (const name of [
        key,
        "NODE_OPTIONS",
        "NODE_PATH",
        "LD_PRELOAD",
        "GITHUB_TOKEN",
        "BOAT_API_KEY",
        "OPENAI_API_KEY",
      ])
        expect(Object.keys(environment)).not.toContain(name);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-bundle-unit-"));
  temporary.push(directory);
  const root = path.join(directory, "root");
  await mkdir(path.join(root, "bin"), { recursive: true, mode: 0o755 });
  await writeFile(path.join(root, "bin/node"), "fixture node\n", {
    mode: 0o555,
  });
  await symlink("node", path.join(root, "bin/alias"));
  for (const name of [
    "bin/start-engine.sh",
    "lib/zeros/setup-cloud-workspace.mjs",
    "lib/zeros/cloud-worker-supervisor.mjs",
  ]) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), "", { mode: 0o555 });
  }
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
      "bin/start-engine.sh",
      "lib",
      "lib/zeros",
      "lib/zeros/cloud-worker-supervisor.mjs",
      "lib/zeros/setup-cloud-workspace.mjs",
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

  it("lists the self-test entrypoint only when its regular file is included", async () => {
    const { root, manifest } = await fixture();
    expect(manifest.entrypoints).not.toHaveProperty("selfTest");
    await writeFile(path.join(root, "lib/zeros/runtime-self-test.mjs"), "", {
      mode: 0o555,
    });
    const withSelfTest = createManifest(
      {
        source: manifest.source,
        agents: manifest.agents,
        engineProtocolVersion: manifest.protocols.engine,
      },
      await inventoryTree(root),
    );
    expect(withSelfTest.entrypoints.selfTest).toBe(
      "lib/zeros/runtime-self-test.mjs",
    );
  });

  it.each(["missing", "dir", "symlink"] as const)(
    "rejects every listed entrypoint backed by a %s inventory entry",
    async (type) => {
      const { root, manifest } = await fixture();
      await writeFile(path.join(root, "lib/zeros/runtime-self-test.mjs"), "", {
        mode: 0o555,
      });
      const files = (await inventoryTree(root)).filter(
        (entry) => entry.path !== "bin/alias",
      );
      const entrypoints = {
        ...manifest.entrypoints,
        selfTest: "lib/zeros/runtime-self-test.mjs",
      };
      for (const target of Object.values(entrypoints)) {
        const invalid = files.flatMap((entry): ManifestEntry[] => {
          if (entry.path !== target) return [entry];
          if (type === "missing") return [];
          if (type === "dir") return [{ path: target, type, mode: "0555" }];
          return [{ path: target, type, target: "." }];
        });
        expect(() =>
          parseManifest(
            canonicalJson({ ...manifest, entrypoints, files: invalid }),
          ),
        ).toThrow(/file_inventory/);
      }
    },
  );
});

describe("shared producer/consumer limits", () => {
  const gib = 1024 ** 3;
  const descriptor = {
    runtimeId: "r1-" + "a".repeat(64),
    manifestSha256: "a".repeat(64),
    archiveSha256: "b".repeat(64),
    archiveBytes: 1,
    expandedBytes: 1,
    sourceCommit: "c".repeat(40),
    nodeModulesAbi: 127,
    bootstrapProtocolVersion: 1,
    engineProtocolVersion: 20,
  };

  it("accepts descriptor size/protocol boundaries", () => {
    expect(descriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(
      descriptorSchema.safeParse({
        ...descriptor,
        archiveBytes: 2 * gib,
        expandedBytes: 4 * gib,
        nodeModulesAbi: 65_535,
        engineProtocolVersion: 65_535,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["archiveBytes", 0],
    ["archiveBytes", 2 * gib + 1],
    ["expandedBytes", 0],
    ["expandedBytes", 4 * gib + 1],
    ["nodeModulesAbi", 0],
    ["nodeModulesAbi", 65_536],
    ["engineProtocolVersion", 0],
    ["engineProtocolVersion", 65_536],
  ])("rejects descriptor %s = %i", (field, value) => {
    expect(
      descriptorSchema.safeParse({ ...descriptor, [field]: value }).success,
    ).toBe(false);
  });

  it("bounds expanded payload totals while allowing individual empty files", async () => {
    const { manifest } = await fixture();
    for (const total of [1, 4 * gib]) {
      const files = manifest.files.map((entry) =>
        entry.type === "file"
          ? { ...entry, size: entry.path === "bin/node" ? total : 0 }
          : entry,
      );
      expect(() =>
        parseManifest(canonicalJson({ ...manifest, files })),
      ).not.toThrow();
    }
    for (const total of [0, 4 * gib + 1]) {
      const files = manifest.files.map((entry) =>
        entry.type === "file"
          ? { ...entry, size: entry.path === "bin/node" ? total : 0 }
          : entry,
      );
      expect(() =>
        parseManifest(canonicalJson({ ...manifest, files })),
      ).toThrow();
    }
    const files = manifest.files.map((entry) =>
      entry.type === "file" ? { ...entry, size: gib + 1 } : entry,
    );
    expect(() => parseManifest(canonicalJson({ ...manifest, files }))).toThrow(
      /expanded_size/,
    );
  });

  it("accepts 250,000 inventory entries and rejects the next entry", () => {
    const entries: ManifestEntry[] = Array.from(
      { length: 250_000 },
      (_, index) => ({
        path: `entry-${String(index).padStart(6, "0")}`,
        type: "dir",
        mode: "0755",
      }),
    );
    expect(() => validateFiles(entries)).not.toThrow();
    entries.push({ path: "entry-250000", type: "dir", mode: "0755" });
    expect(() => validateFiles(entries)).toThrow(/file_inventory/);
  });

  it("bounds paths and link targets by UTF-8 bytes", () => {
    expect(validPath("é".repeat(2048))).toBe(true);
    expect(validPath("é".repeat(2048) + "a")).toBe(false);
    const file: ManifestEntry = {
      path: "é",
      type: "file",
      mode: "0444",
      size: 1,
      sha256: sha256(Buffer.from("a")),
    };
    const target = "./".repeat(2047) + "é";
    expect(Buffer.byteLength(target)).toBe(4096);
    expect(() =>
      validateFiles([{ path: "link", type: "symlink", target }, file]),
    ).not.toThrow();
    expect(() =>
      validateFiles([
        { path: "link", type: "symlink", target: "./".repeat(2047) + "/é" },
        file,
      ]),
    ).toThrow();
  });

  it("allows 64 symlink resolutions but rejects a 65-link chain", () => {
    function chain(length: number): ManifestEntry[] {
      return [
        ...Array.from(
          { length },
          (_, index): ManifestEntry => ({
            path: `link-${String(index).padStart(2, "0")}`,
            type: "symlink",
            target:
              index === length - 1
                ? "payload"
                : `link-${String(index + 1).padStart(2, "0")}`,
          }),
        ),
        {
          path: "payload",
          type: "file",
          mode: "0444",
          size: 1,
          sha256: sha256(Buffer.from("a")),
        },
      ];
    }
    expect(() => validateFiles(chain(64))).not.toThrow();
    expect(() => validateFiles(chain(65))).toThrow(/symlink_cycle/);
  });

  it("bounds manifest protocol integers", async () => {
    const { manifest } = await fixture();
    expect(() =>
      parseManifest(
        canonicalJson({
          ...manifest,
          protocols: { ...manifest.protocols, engine: 65_535 },
        }),
      ),
    ).not.toThrow();
    for (const engine of [0, 65_536]) {
      expect(() =>
        parseManifest(
          canonicalJson({
            ...manifest,
            protocols: { ...manifest.protocols, engine },
          }),
        ),
      ).toThrow(/manifest_schema/);
    }
    for (const nodeModulesAbi of [0, 65_536]) {
      expect(() =>
        parseManifest(
          canonicalJson({
            ...manifest,
            platform: { ...manifest.platform, nodeModulesAbi },
          }),
        ),
      ).toThrow(/manifest_schema/);
    }
  });

  it("uses the shared bounded agent-version grammar for every provider", async () => {
    const { manifest } = await fixture();
    for (const version of ["vNext-1.2", "A".repeat(64), "1"]) {
      expect(() =>
        parseManifest(
          canonicalJson({
            ...manifest,
            agents: {
              claude: { cli: version, sdk: version },
              codex: { package: version },
              cursor: { sdk: version },
            },
          }),
        ),
      ).not.toThrow();
    }
    for (const version of [
      "",
      "a".repeat(65),
      "1.2.3+build",
      "1.2.3-rc_1",
      "-1.2.3",
      ".1",
      "1 2",
    ]) {
      for (const [provider, field] of [
        ["claude", "cli"],
        ["claude", "sdk"],
        ["codex", "package"],
        ["cursor", "sdk"],
      ] as const) {
        expect(() =>
          parseManifest(
            canonicalJson({
              ...manifest,
              agents: {
                ...manifest.agents,
                [provider]: { ...manifest.agents[provider], [field]: version },
              },
            }),
          ),
        ).toThrow(/manifest_schema/);
      }
    }
  });
});

describe("runtime archive", () => {
  it.each([
    [0, false],
    [1, true],
    [2 * 1024 ** 3, true],
    [2 * 1024 ** 3 + 1, false],
  ] as const)(
    "bounds compressed output at %i bytes",
    async (size, accepted) => {
      // Reuse one buffer and discard accepted output; no multi-GiB allocation/I/O.
      const chunk = Buffer.alloc(1024 ** 2);
      function* chunks() {
        for (let remaining = size; remaining > 0; remaining -= chunk.length)
          yield chunk.subarray(0, Math.min(remaining, chunk.length));
      }
      let written = 0;
      const output = pipeline(
        Readable.from(chunks()),
        archiveByteLimit(),
        new Writable({
          write(bytes: Buffer, _encoding, callback) {
            written += bytes.length;
            callback();
          },
        }),
      );
      if (accepted) await expect(output).resolves.toBeUndefined();
      else await expect(output).rejects.toThrow(/archive_size/);
      expect(written).toBe(Math.min(size, 2 * 1024 ** 3));
    },
  );

  it.each([0, 2 * 1024 ** 3 + 1])(
    "rejects a %i-byte archive before hashing or decompression",
    async (size) => {
      const { directory } = await fixture();
      const archivePath = path.join(directory, "oversized.tar.gz");
      await writeFile(archivePath, "");
      await truncate(archivePath, size); // Sparse fixture: no multi-GiB allocation.
      await expect(verifyRuntimeArchive({ archivePath })).rejects.toThrow(
        /archive_size/,
      );
    },
    30_000,
  );

  it("enforces the 16 KiB PAX header limit in the producer", () => {
    expect(() =>
      tarHeader({
        path: "PaxHeaders/entry",
        type: "pax",
        mode: "0444",
        size: 16 * 1024,
      }),
    ).not.toThrow();
    expect(() =>
      tarHeader({
        path: "PaxHeaders/entry",
        type: "pax",
        mode: "0444",
        size: 16 * 1024 + 1,
      }),
    ).toThrow(/pax_records/);
  });

  it("rejects oversized PAX payloads before reading them", async () => {
    const { directory, bytes } = await fixture();
    const header = tarHeader({
      path: "PaxHeaders/entry",
      type: "pax",
      mode: "0444",
      size: 16 * 1024,
    });
    header.write((16 * 1024 + 1).toString(8).padStart(11, "0") + "\0", 124);
    header.fill(32, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    const archivePath = path.join(directory, "oversized-pax.tar.gz");
    await writeFile(
      archivePath,
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
          header,
        ]),
        { level: 9 },
      ),
    );
    await expect(verifyRuntimeArchive({ archivePath })).rejects.toThrow(
      /pax_records/,
    );
  });

  it("extracts manifest modes independently of the verifier's umask", async () => {
    const { root, directory, bytes } = await fixture();
    const archivePath = path.join(directory, "modes.tar.gz");
    await writeRuntimeArchive(root, bytes, archivePath);
    const previous = process.umask(0o077);
    try {
      await expect(
        verifyRuntimeArchive({
          archivePath,
          manifestBytes: bytes,
          extractTo: path.join(directory, "extracted"),
        }),
      ).resolves.toBeTruthy();
    } finally {
      process.umask(previous);
    }
  });

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
