import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";
import {
  BundleError,
  canonicalJson,
  check,
  descriptorSchema,
  inventoryTree,
  MAX_MANIFEST_BYTES,
  parseManifest,
  sha256,
  sha256File,
  validMode,
  validPath,
  type ManifestEntry,
  type RuntimeDescriptor,
  type RuntimeManifest,
} from "./manifest";
import { runClosureProbes, type ClosureReport } from "./probe";

class TarReader {
  private buffered: Buffer = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer>;
  constructor(stream: AsyncIterable<Buffer>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }
  async read(length: number, allowEnd = false): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      if (this.buffered.length === 0) {
        const next = await this.iterator.next();
        if (next.done) {
          if (allowEnd && remaining === length) return null;
          throw new BundleError("archive_truncated");
        }
        this.buffered = next.value;
      }
      const take = Math.min(remaining, this.buffered.length);
      chunks.push(this.buffered.subarray(0, take));
      this.buffered = this.buffered.subarray(take);
      remaining -= take;
    }
    return Buffer.concat(chunks, length);
  }
  async payload(
    length: number,
    consume: (chunk: Buffer) => Promise<void> | void,
  ): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      const count = Math.min(remaining, 64 * 1024);
      await consume((await this.read(count))!);
      remaining -= count;
    }
    const padding = (await this.read((512 - (length % 512)) % 512))!;
    check(
      padding.every((byte) => byte === 0),
      "tar_padding",
    );
  }
}

type TarHeader = {
  path: string;
  mode: string;
  size: number;
  target: string;
  type: "file" | "dir" | "symlink" | "pax";
};
function parseHeader(bytes: Buffer): TarHeader {
  function string(offset: number, length: number): string {
    const field = bytes.subarray(offset, offset + length);
    const zero = field.indexOf(0);
    if (zero !== -1)
      check(
        field.subarray(zero).every((byte) => byte === 0),
        "tar_metadata",
      );
    const text = field
      .subarray(0, zero === -1 ? field.length : zero)
      .toString("utf8");
    check(
      Buffer.from(text).equals(
        field.subarray(0, zero === -1 ? field.length : zero),
      ),
      "archive_paths",
    );
    return text;
  }
  function octal(offset: number, length: number): number {
    const field = bytes.subarray(offset, offset + length).toString("ascii");
    check(/^[0-7]+[\0 ]*$/.test(field), "tar_metadata");
    const value = parseInt(field, 8);
    check(Number.isSafeInteger(value), "tar_metadata");
    return value;
  }
  const expectedChecksum = octal(148, 8);
  const checksum = bytes.reduce(
    (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
    0,
  );
  check(expectedChecksum === checksum, "tar_checksum");
  const prefix = string(345, 155);
  const name = string(0, 100);
  const filename = prefix ? `${prefix}/${name}` : name;
  check(validPath(filename), "archive_paths");
  const types: Record<string, TarHeader["type"] | undefined> = {
    "0": "file",
    "5": "dir",
    "2": "symlink",
    x: "pax",
  };
  const type = types[string(156, 1)];
  check(type, "archive_member_type");
  const permissions = octal(100, 8).toString(8).padStart(4, "0");
  check(validMode(permissions), "file_mode");
  check(
    octal(108, 8) === 0 &&
      octal(116, 8) === 0 &&
      octal(136, 12) === 0 &&
      octal(329, 8) === 0 &&
      octal(337, 8) === 0 &&
      string(265, 32) === "" &&
      string(297, 32) === "" &&
      string(257, 6) === "ustar" &&
      string(263, 2) === "00" &&
      bytes.subarray(500).every((byte) => byte === 0),
    "tar_metadata",
  );
  const size = octal(124, 12);
  const target = string(157, 100);
  check(
    (type === "file" || type === "pax" || size === 0) &&
      (type === "symlink" || target === ""),
    "tar_metadata",
  );
  return { path: filename, mode: permissions, size, target, type };
}

function parsePax(bytes: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  for (let offset = 0; offset < bytes.length; ) {
    const space = bytes.indexOf(32, offset);
    check(space > offset && space - offset < 8, "pax_records");
    const digits = bytes.subarray(offset, space).toString("ascii");
    check(/^[1-9]\d*$/.test(digits), "pax_records");
    const length = Number(digits);
    check(
      length > space - offset + 3 &&
        offset + length <= bytes.length &&
        bytes[offset + length - 1] === 10,
      "pax_records",
    );
    const record = bytes.subarray(space + 1, offset + length - 1);
    const text = record.toString("utf8");
    check(Buffer.from(text).equals(record), "pax_records");
    const equal = text.indexOf("=");
    const key = text.slice(0, equal),
      value = text.slice(equal + 1);
    check(
      (key === "path" || key === "linkpath") &&
        value.length > 0 &&
        !records.has(key) &&
        !/[\0\r\n]/.test(value),
      "pax_records",
    );
    records.set(key, value);
    offset += length;
  }
  check(records.size > 0, "pax_records");
  return records;
}

export async function verifyRuntimeTree(
  root: string,
  manifestBytes: Buffer,
): Promise<void> {
  const manifest = parseManifest(manifestBytes);
  const saved = await readFile(path.join(root, "manifest.json"));
  const info = await lstat(path.join(root, "manifest.json"));
  check(
    info.isFile() &&
      info.nlink === 1 &&
      (info.mode & 0o7777) === 0o444 &&
      saved.equals(manifestBytes),
    "manifest_digest",
  );
  check(
    canonicalJson(await inventoryTree(root)).equals(
      canonicalJson(manifest.files),
    ),
    "tree_inventory",
  );
}

/** Independently consumes headers and file bytes before running any runtime code.
 * Extraction is optional, exclusive, and never follows archive symlink parents. */
export async function verifyRuntimeArchive(options: {
  archivePath: string;
  manifestBytes?: Buffer;
  descriptor?: RuntimeDescriptor;
  extractTo?: string;
}): Promise<{
  manifest: RuntimeManifest;
  manifestBytes: Buffer;
  descriptor: RuntimeDescriptor;
}> {
  const archiveInfo = await stat(options.archivePath);
  const archiveSha256 = await sha256File(options.archivePath);
  const file = await open(options.archivePath, "r");
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(10), 0, 10, 0);
    check(
      bytesRead === 10 &&
        buffer.equals(Buffer.from([31, 139, 8, 0, 0, 0, 0, 0, 2, 3])),
      "gzip_header",
    );
  } finally {
    await file.close();
  }
  if (options.descriptor) {
    check(
      descriptorSchema.safeParse(options.descriptor).success,
      "descriptor_schema",
    );
    check(archiveSha256 === options.descriptor.archiveSha256, "archive_digest");
    check(archiveInfo.size === options.descriptor.archiveBytes, "archive_size");
  }
  const compressed = createReadStream(options.archivePath);
  const uncompressed = createGunzip();
  compressed.on("error", (error) => uncompressed.destroy(error));
  compressed.pipe(uncompressed);
  const reader = new TarReader(uncompressed);
  let created = false;
  try {
    const first = parseHeader((await reader.read(512))!);
    check(
      first.path === "manifest.json" &&
        first.type === "file" &&
        first.mode === "0444",
      "manifest_first",
    );
    check(first.size <= MAX_MANIFEST_BYTES, "manifest_size");
    const chunks: Buffer[] = [];
    await reader.payload(first.size, (chunk) => {
      chunks.push(chunk);
    });
    const manifestBytes = Buffer.concat(chunks);
    if (options.manifestBytes)
      check(options.manifestBytes.equals(manifestBytes), "manifest_digest");
    const manifest = parseManifest(manifestBytes);
    const manifestSha256 = sha256(manifestBytes);
    const descriptor: RuntimeDescriptor = {
      runtimeId: `r1-${manifestSha256}`,
      manifestSha256,
      archiveSha256,
      archiveBytes: archiveInfo.size,
      expandedBytes: manifest.files.reduce(
        (sum, entry) => sum + (entry.type === "file" ? entry.size : 0),
        0,
      ),
      sourceCommit: manifest.source.commit,
      nodeModulesAbi: manifest.platform.nodeModulesAbi,
      bootstrapProtocolVersion: manifest.protocols.bootstrap,
      engineProtocolVersion: manifest.protocols.engine,
    };
    if (options.descriptor)
      check(
        canonicalJson(options.descriptor).equals(canonicalJson(descriptor)),
        "descriptor_identity",
      );
    if (options.extractTo) {
      const existing = await lstat(options.extractTo).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        },
      );
      check(!existing, "extraction_exists");
      await mkdir(options.extractTo, { recursive: true, mode: 0o755 });
      created = true;
      await writeFile(
        path.join(options.extractTo, "manifest.json"),
        manifestBytes,
        { mode: 0o444, flag: "wx" },
      );
    }
    const links: Extract<ManifestEntry, { type: "symlink" }>[] = [];
    for (const entry of manifest.files) {
      const raw = (await reader.read(512))!;
      check(!raw.every((byte) => byte === 0), "file_inventory");
      let header = parseHeader(raw);
      if (header.type === "pax") {
        check(header.size <= 64 * 1024, "pax_records");
        const records: Buffer[] = [];
        await reader.payload(header.size, (chunk) => {
          records.push(chunk);
        });
        const overrides = parsePax(Buffer.concat(records));
        header = parseHeader((await reader.read(512))!);
        check(header.type !== "pax", "pax_records");
        if (overrides.has("path")) header.path = overrides.get("path")!;
        if (overrides.has("linkpath")) {
          check(header.type === "symlink", "pax_records");
          header.target = overrides.get("linkpath")!;
        }
      }
      check(validPath(header.path), "archive_paths");
      check(
        header.path === entry.path && header.type === entry.type,
        "file_inventory",
      );
      if (entry.type !== "symlink")
        check(header.mode === entry.mode, "file_mode");
      if (entry.type === "symlink") {
        check(header.target === entry.target, "symlink_target");
        links.push(entry);
      } else if (entry.type === "dir") {
        if (options.extractTo)
          await mkdir(path.join(options.extractTo, entry.path), {
            mode: 0o755,
          });
      } else {
        check(header.size === entry.size, "file_size");
        const hash = createHash("sha256");
        const destination = options.extractTo
          ? await open(
              path.join(options.extractTo, entry.path),
              "wx",
              parseInt(entry.mode, 8),
            )
          : undefined;
        try {
          await reader.payload(header.size, async (chunk) => {
            hash.update(chunk);
            if (destination) await destination.writeFile(chunk);
          });
        } finally {
          await destination?.close();
        }
        check(hash.digest("hex") === entry.sha256, "file_digest");
      }
    }
    check(
      (await reader.read(1024))!.every((byte) => byte === 0),
      "file_inventory",
    );
    check((await reader.read(1, true)) === null, "archive_trailing_data");
    if (options.extractTo) {
      for (const entry of links)
        await symlink(entry.target, path.join(options.extractTo, entry.path));
      for (const entry of [...manifest.files].reverse()) {
        if (entry.type === "dir")
          await chmod(
            path.join(options.extractTo, entry.path),
            parseInt(entry.mode, 8),
          );
      }
      await verifyRuntimeTree(options.extractTo, manifestBytes);
    }
    return { manifest, manifestBytes, descriptor };
  } catch (error) {
    if (created && options.extractTo)
      await rm(options.extractTo, { recursive: true, force: true });
    throw error;
  } finally {
    compressed.destroy();
    uncompressed.destroy();
  }
}

export async function verifyBundleDirectory(
  directory: string,
  closure = false,
): Promise<{
  manifest: RuntimeManifest;
  descriptor: RuntimeDescriptor;
  closure?: ClosureReport;
  durationMs: number;
}> {
  const started = performance.now();
  const descriptor = descriptorSchema.safeParse(
    JSON.parse(await readFile(path.join(directory, "descriptor.json"), "utf8")),
  );
  check(descriptor.success, "descriptor_schema");
  const manifestBytes = await readFile(path.join(directory, "manifest.json"));
  const temporary = closure
    ? await mkdtemp(path.join(os.tmpdir(), "zeros-runtime-verify-"))
    : undefined;
  const installed = temporary
    ? path.join(temporary, "opt/zeros-infra", descriptor.data.runtimeId)
    : undefined;
  try {
    const verified = await verifyRuntimeArchive({
      archivePath: path.join(directory, `${descriptor.data.runtimeId}.tar.gz`),
      manifestBytes,
      descriptor: descriptor.data,
      extractTo: installed,
    });
    const report = installed ? await runClosureProbes(installed) : undefined;
    return {
      manifest: verified.manifest,
      descriptor: verified.descriptor,
      ...(report ? { closure: report } : {}),
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void (async () => {
    const { values } = parseArgs({
      options: {
        "out-dir": { type: "string" },
        closure: { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
    });
    if (values.help) {
      console.log(
        "Usage: pnpm cloud:runtime-bundle:verify --out-dir <directory> [--closure]",
      );
      return;
    }
    check(values["out-dir"], "input_schema");
    await verifyBundleDirectory(
      path.resolve(values["out-dir"]),
      values.closure,
    );
    console.log(
      JSON.stringify({
        schema: "zeros.diagnostic/v1",
        component: "bundle",
        stage: "done",
        ok: true,
        exitCode: 0,
        timedOut: false,
        failedChecks: [],
      }),
    );
  })().catch((error: unknown) => {
    console.log(
      JSON.stringify({
        schema: "zeros.diagnostic/v1",
        component: "bundle",
        stage: "verify_bundle",
        ok: false,
        exitCode: null,
        timedOut: false,
        failedChecks: [
          error instanceof BundleError ? error.check : "unexpected_failure",
        ],
      }),
    );
    process.exitCode = 1;
  });
}
