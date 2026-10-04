import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  BundleError,
  check,
  MAX_ARCHIVE_BYTES,
  MAX_PAX_BYTES,
  parseManifest,
  validMode,
  validPath,
  type ManifestEntry,
} from "./manifest";

type HeaderInput = {
  path: string;
  type: "file" | "dir" | "symlink" | "pax";
  mode: string;
  size?: number;
  target?: string;
  prefix?: string;
};
function octal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const text = value.toString(8);
  check(
    Number.isSafeInteger(value) && value >= 0 && text.length < length,
    "tar_size",
  );
  header.write(text.padStart(length - 1, "0") + "\0", offset, length, "ascii");
}
export function tarHeader(input: HeaderInput): Buffer {
  check(validPath(input.path), "archive_paths");
  check(validMode(input.mode), "file_mode");
  if (input.type === "pax")
    check((input.size ?? 0) <= MAX_PAX_BYTES, "pax_records");
  const header = Buffer.alloc(512);
  for (const [text, offset, limit] of [
    [input.path, 0, 100],
    [input.target ?? "", 157, 100],
    [input.prefix ?? "", 345, 155],
  ] as const) {
    check(Buffer.byteLength(text) <= limit, "tar_path_length");
    header.write(text, offset, limit, "utf8");
  }
  octal(header, 100, 8, parseInt(input.mode, 8));
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, input.size ?? 0);
  octal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header.write(
    { file: "0", dir: "5", symlink: "2", pax: "x" }[input.type],
    156,
  );
  header.write("ustar\0", 257);
  header.write("00", 263);
  octal(header, 329, 8, 0);
  octal(header, 337, 8, 0);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
  return header;
}

export function paxRecord(key: "path" | "linkpath", value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length)
    length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(String(length) + body);
}
function ustarName(
  name: string,
): { path: string; prefix?: string } | undefined {
  if (Buffer.byteLength(name) <= 100) return { path: name };
  for (
    let slash = name.lastIndexOf("/");
    slash > 0;
    slash = name.lastIndexOf("/", slash - 1)
  ) {
    const prefix = name.slice(0, slash),
      suffix = name.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100)
      return { path: suffix, prefix };
  }
  return undefined;
}
export const padding = (length: number) =>
  Buffer.alloc((512 - (length % 512)) % 512);

/** Bound compressed output while writing, before an oversized artifact exists. */
export function archiveByteLimit(): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) callback(new BundleError("archive_size"));
      else callback(null, chunk);
    },
    flush(callback) {
      callback(bytes > 0 ? null : new BundleError("archive_size"));
    },
  });
}

function* entryHeaders(entry: ManifestEntry, index: number): Generator<Buffer> {
  const name = ustarName(entry.path);
  const link = entry.type === "symlink" ? entry.target : "";
  const extended: Buffer[] = [];
  // PAX keys use the same byte order as JSON keys, independent of host locale.
  if (Buffer.byteLength(link) > 100) extended.push(paxRecord("linkpath", link));
  if (!name) extended.push(paxRecord("path", entry.path));
  const suffix = String(index).padStart(8, "0");
  if (extended.length) {
    const payload = Buffer.concat(extended);
    yield tarHeader({
      path: `PaxHeaders/${suffix}`,
      type: "pax",
      mode: "0444",
      size: payload.length,
    });
    yield payload;
    yield padding(payload.length);
  }
  yield tarHeader({
    ...(name ?? { path: `PaxEntry/${suffix}` }),
    type: entry.type,
    mode: entry.type === "symlink" ? "0555" : entry.mode,
    size: entry.type === "file" ? entry.size : 0,
    target: Buffer.byteLength(link) <= 100 ? link : "",
  });
}

/** Ordinary copied members only; fixed headers and zlib's filename-free epoch
 * gzip header. Files are rehashed while writing, so a stale inventory fails. */
export async function writeRuntimeArchive(
  root: string,
  manifestBytes: Buffer,
  output: string,
): Promise<void> {
  const manifest = parseManifest(manifestBytes);
  async function* tar(): AsyncGenerator<Buffer> {
    yield tarHeader({
      path: "manifest.json",
      type: "file",
      mode: "0444",
      size: manifestBytes.length,
    });
    yield manifestBytes;
    yield padding(manifestBytes.length);
    for (const [index, entry] of manifest.files.entries()) {
      const filename = path.join(root, entry.path);
      const stat = await lstat(filename);
      if (entry.type === "file") {
        check(
          stat.isFile() && stat.nlink === 1 && stat.size === entry.size,
          "file_inventory",
        );
        check((stat.mode & 0o7777) === parseInt(entry.mode, 8), "file_mode");
      }
      yield* entryHeaders(entry, index);
      if (entry.type === "file") {
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of createReadStream(filename)) {
          const buffer = chunk as Buffer;
          bytes += buffer.length;
          hash.update(buffer);
          yield buffer;
        }
        check(
          bytes === entry.size && hash.digest("hex") === entry.sha256,
          "file_digest",
        );
        yield padding(entry.size);
      }
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(
    Readable.from(tar()),
    createGzip({ level: 9 }),
    archiveByteLimit(),
    createWriteStream(output, { flags: "wx", mode: 0o644 }),
  );
}
