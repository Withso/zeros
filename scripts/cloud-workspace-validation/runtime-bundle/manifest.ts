import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// Cloud v2 contracts §2–4 and §17. Keep the builder independent of its runtime.
export const NODE_VERSION = "22.23.1";
export const NODE_MODULES_ABI = 127;
export const PNPM_VERSION = "10.28.0";
export const PLAYWRIGHT_VERSION = "1.59.1";
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;
export const MAX_EXPANDED_BYTES = 4 * 1024 ** 3;
export const MAX_ENTRIES = 250_000;
export const MAX_PAX_BYTES = 16 * 1024;
export const MAX_PATH_BYTES = 4096;
export const MAX_PROTOCOL_VERSION = 65_535;

export class BundleError extends Error {
  constructor(readonly check: string) {
    super(check);
  }
}
export function check(condition: unknown, name: string): asserts condition {
  if (!condition) throw new BundleError(name);
}
export const byteOrder = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
export const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export function canonicalJson(value: unknown): Buffer {
  function sort(item: unknown): unknown {
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return item;
    if (typeof item === "number") {
      check(Number.isFinite(item), "canonical_json");
      return item;
    }
    if (Array.isArray(item)) return item.map(sort);
    check(typeof item === "object" && item !== null, "canonical_json");
    check(
      Object.getPrototypeOf(item) === Object.prototype ||
        Object.getPrototypeOf(item) === null,
      "canonical_json",
    );
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(item).sort(byteOrder)) {
      check(/^[\x20-\x7e]+$/.test(key), "canonical_json");
      result[key] = sort((item as Record<string, unknown>)[key]);
    }
    return result;
  }
  return Buffer.from(JSON.stringify(sort(value)), "utf8");
}

export function validPath(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_PATH_BYTES &&
    !/[\0\\\r\n]/.test(value) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}
export function validMode(value: string): boolean {
  return /^0[0-7]{3}$/.test(value) && (parseInt(value, 8) & 0o7022) === 0;
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const mode = z.string().refine(validMode);
const relativePath = z.string().refine(validPath);
const size = z.number().int().min(0).max(MAX_EXPANDED_BYTES);
const entrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dir"), path: relativePath, mode }).strict(),
  z
    .object({
      type: z.literal("file"),
      path: relativePath,
      mode,
      size,
      sha256: digest,
    })
    .strict(),
  z
    .object({
      type: z.literal("symlink"),
      path: relativePath,
      target: z
        .string()
        .min(1)
        .refine((value) => Buffer.byteLength(value) <= MAX_PATH_BYTES),
    })
    .strict(),
]);
export type ManifestEntry = z.infer<typeof entrySchema>;
const agentVersion = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/);
const protocolVersion = z.number().int().min(1).max(MAX_PROTOCOL_VERSION);
const manifestSchema = z
  .object({
    schema: z.literal("zeros.runtime-manifest/v1"),
    source: z
      .object({
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        lockfileSha256: digest,
      })
      .strict(),
    platform: z
      .object({
        os: z.literal("linux"),
        arch: z.literal("x64"),
        libc: z.literal("glibc"),
        minGlibc: z.literal("2.39"),
        node: z.literal(NODE_VERSION),
        nodeModulesAbi: z.literal(NODE_MODULES_ABI),
      })
      .strict(),
    protocols: z
      .object({
        bootstrap: z.literal(1),
        engine: protocolVersion,
        setup: z.literal(2),
      })
      .strict(),
    agents: z
      .object({
        claude: z.object({ cli: agentVersion, sdk: agentVersion }).strict(),
        codex: z.object({ package: agentVersion }).strict(),
        cursor: z.object({ sdk: agentVersion }).strict(),
      })
      .strict(),
    entrypoints: z
      .object({
        node: z.literal("bin/node"),
        setup: z.literal("lib/zeros/setup-cloud-workspace.mjs"),
        startEngine: z.literal("bin/start-engine.sh"),
        supervisor: z.literal("lib/zeros/cloud-worker-supervisor.mjs"),
        selfTest: z.literal("lib/zeros/runtime-self-test.mjs").optional(),
      })
      .strict(),
    files: z.array(entrySchema).max(MAX_ENTRIES),
  })
  .strict();
export type RuntimeManifest = z.infer<typeof manifestSchema>;
export const descriptorSchema = z
  .object({
    runtimeId: z.string().regex(/^r1-[a-f0-9]{64}$/),
    manifestSha256: digest,
    archiveSha256: digest,
    archiveBytes: z.number().int().min(1).max(MAX_ARCHIVE_BYTES),
    expandedBytes: size.min(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    nodeModulesAbi: protocolVersion,
    bootstrapProtocolVersion: z.literal(1),
    engineProtocolVersion: protocolVersion,
  })
  .strict();
export type RuntimeDescriptor = z.infer<typeof descriptorSchema>;

function lexicalTarget(link: string, target: string): void {
  check(
    !target.startsWith("/") && !/[\0\\\r\n]/.test(target),
    "symlink_escape",
  );
  const parts = link.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") {
      check(parts.length > 0, "symlink_escape");
      parts.pop();
    } else if (part !== "." && part !== "") parts.push(part);
  }
}

export function validateFiles(files: readonly ManifestEntry[]): void {
  const entries = new Map<string, ManifestEntry>();
  let previous: string | undefined;
  let total = 0;
  check(files.length <= MAX_ENTRIES, "file_inventory");
  for (const entry of files) {
    check(
      validPath(entry.path) && entry.path !== "manifest.json",
      "archive_paths",
    );
    if (entry.type !== "symlink") check(validMode(entry.mode), "file_mode");
    check(entrySchema.safeParse(entry).success, "file_inventory");
    check(
      previous === undefined || byteOrder(previous, entry.path) < 0,
      "file_inventory",
    );
    previous = entry.path;
    const parent = path.posix.dirname(entry.path);
    check(
      parent === "." || entries.get(parent)?.type === "dir",
      "archive_paths",
    );
    entries.set(entry.path, entry);
    if (entry.type === "file") total += entry.size;
    if (entry.type === "symlink") lexicalTarget(entry.path, entry.target);
  }
  check(total <= MAX_EXPANDED_BYTES, "expanded_size");
  // Resolve component-by-component: normalizing a/linked-dir/../x first can
  // conceal an escape. Directory ancestors in the archive itself cannot be links.
  for (const link of files) {
    if (link.type !== "symlink") continue;
    const pending = link.path.split("/");
    const resolved: string[] = [];
    let followed = 0;
    while (pending.length) {
      const part = pending.shift()!;
      if (part === "." || part === "") continue;
      if (part === "..") {
        check(resolved.length > 0, "symlink_escape");
        resolved.pop();
        continue;
      }
      const entry = entries.get([...resolved, part].join("/"));
      check(entry, "symlink_dangling");
      if (entry.type === "symlink") {
        check(++followed <= 64, "symlink_cycle");
        pending.unshift(...entry.target.split("/"));
      } else {
        check(pending.length === 0 || entry.type === "dir", "symlink_dangling");
        resolved.push(part);
      }
    }
  }
}

export async function inventoryTree(root: string): Promise<ManifestEntry[]> {
  const files: ManifestEntry[] = [];
  async function walk(directory: string): Promise<void> {
    for (const name of await readdir(path.join(root, directory))) {
      const relative = directory ? `${directory}/${name}` : name;
      const filename = path.join(root, relative);
      const stat = await lstat(filename);
      if (relative === "manifest.json") {
        check(stat.isFile(), "archive_paths");
        continue;
      }
      check(validPath(relative), "archive_paths");
      if (stat.isSymbolicLink())
        files.push({
          path: relative,
          type: "symlink",
          target: await readlink(filename),
        });
      else {
        const permissions = (stat.mode & 0o7777).toString(8).padStart(4, "0");
        check(validMode(permissions), "file_mode");
        if (stat.isDirectory()) {
          files.push({ path: relative, type: "dir", mode: permissions });
          await walk(relative);
        } else {
          check(stat.isFile(), "archive_member_type");
          check(stat.nlink === 1, "hard_link");
          files.push({
            path: relative,
            type: "file",
            mode: permissions,
            size: stat.size,
            sha256: await sha256File(filename),
          });
        }
      }
    }
  }
  await walk("");
  files.sort((a, b) => byteOrder(a.path, b.path));
  validateFiles(files);
  return files;
}

export function createManifest(
  input: {
    agents: RuntimeManifest["agents"];
    source: RuntimeManifest["source"];
    engineProtocolVersion: number;
  },
  files: ManifestEntry[],
): RuntimeManifest {
  const manifest: RuntimeManifest = {
    schema: "zeros.runtime-manifest/v1",
    source: input.source,
    agents: input.agents,
    platform: {
      os: "linux",
      arch: "x64",
      libc: "glibc",
      minGlibc: "2.39",
      node: NODE_VERSION,
      nodeModulesAbi: NODE_MODULES_ABI,
    },
    protocols: { bootstrap: 1, engine: input.engineProtocolVersion, setup: 2 },
    entrypoints: {
      node: "bin/node",
      startEngine: "bin/start-engine.sh",
      setup: "lib/zeros/setup-cloud-workspace.mjs",
      supervisor: "lib/zeros/cloud-worker-supervisor.mjs",
      ...(files.some(
        (entry) =>
          entry.type === "file" &&
          entry.path === "lib/zeros/runtime-self-test.mjs",
      )
        ? { selfTest: "lib/zeros/runtime-self-test.mjs" as const }
        : {}),
    },
    files,
  };
  return parseManifest(canonicalJson(manifest));
}

export function parseManifest(bytes: Buffer): RuntimeManifest {
  check(bytes.length <= MAX_MANIFEST_BYTES, "manifest_size");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new BundleError("manifest_schema");
  }
  // Also rejects duplicate keys, non-UTF-8 bytes, whitespace and trailing data.
  check(canonicalJson(value).equals(bytes), "manifest_canonical");
  const parsed = manifestSchema.safeParse(value);
  check(parsed.success, "manifest_schema");
  validateFiles(parsed.data.files);
  const regularFiles = new Set(
    parsed.data.files
      .filter((entry) => entry.type === "file")
      .map((entry) => entry.path),
  );
  check(
    Object.values(parsed.data.entrypoints).every((entry) =>
      regularFiles.has(entry),
    ),
    "file_inventory",
  );
  check(
    parsed.data.files.some((entry) => entry.type === "file" && entry.size > 0),
    "expanded_size",
  );
  return parsed.data;
}
