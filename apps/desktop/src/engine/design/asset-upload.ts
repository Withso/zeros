import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DESIGN_ASSET_MIME_TYPES, MAX_ASSET_BYTES } from "./assets";
import { designDirectoryNameFor } from "./directory-registry";
import {
  assertSafeDesignStoragePath,
  syncDesignStorageDirectory,
} from "./metadata-storage";
import { publishCloudWorkspacePath } from "../files/cloud-workspace-ownership";

const MAX_BASE64 = Math.ceil(MAX_ASSET_BYTES / 3) * 4;
const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};
const safeFilename = (name: string) =>
  !/[/\\:]/.test(name) &&
  !name.startsWith(".") &&
  ![...name].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
export const designAssetUploadSchema = z
  .object({
    workspaceId: z.literal("local-main"),
    directoryId: z.string().regex(/^design_[a-zA-Z0-9_-]{1,64}$/),
    frame: z.string().max(1024),
    sourceVersion: z.string().min(1).max(256),
    name: z
      .string()
      .min(1)
      .max(200)
      .refine(safeFilename, "Choose an image filename without a path."),
    mimeType: z.enum([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/avif",
    ]),
    data: z.string().min(4).max(MAX_BASE64),
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000),
  })
  .strict();

/** Only the validated, content-addressed image enters the private journal.
 * No client path is accepted, and bytes are never part of semantic history. */
export interface DesignUploadedAsset {
  file: string;
  mimeType: string;
  data: string;
}

function decodeImage(data: string, mimeType: string): Buffer {
  if (
    !extensions[mimeType] ||
    data.length > MAX_BASE64 ||
    data.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    throw new Error("Choose a supported image of at most 10 MiB.");
  const bytes = Buffer.from(data, "base64");
  if (
    !bytes.length ||
    bytes.length > MAX_ASSET_BYTES ||
    bytes.toString("base64") !== data
  )
    throw new Error("Choose a supported image of at most 10 MiB.");
  const text = (start: number, end: number) =>
    bytes.toString("ascii", start, end);
  const valid =
    mimeType === "image/png"
      ? bytes.length >= 24 &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        text(12, 16) === "IHDR"
      : mimeType === "image/jpeg"
        ? bytes.length >= 4 &&
          bytes[0] === 255 &&
          bytes[1] === 216 &&
          bytes[2] === 255
        : mimeType === "image/gif"
          ? bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(text(0, 6))
          : mimeType === "image/webp"
            ? bytes.length >= 16 &&
              text(0, 4) === "RIFF" &&
              text(8, 12) === "WEBP"
            : bytes.length >= 16 &&
              text(4, 8) === "ftyp" &&
              ["avif", "avis"].includes(text(8, 12));
  if (!valid) throw new Error("The image contents do not match its file type.");
  return bytes;
}

function assetFile(bytes: Buffer, mimeType: string): string {
  return `assets/${createHash("sha256").update(bytes).digest("hex")}.${extensions[mimeType]}`;
}

export function prepareDesignAssetUpload(input: {
  name: string;
  mimeType: string;
  data: string;
}): DesignUploadedAsset {
  if (
    !safeFilename(input.name) ||
    input.name.length > 200 ||
    DESIGN_ASSET_MIME_TYPES[path.extname(input.name).toLowerCase()] !==
      input.mimeType
  )
    throw new Error("Choose a supported image filename without a path.");
  const bytes = decodeImage(input.data, input.mimeType);
  return Object.freeze({
    file: assetFile(bytes, input.mimeType),
    mimeType: input.mimeType,
    data: input.data,
  });
}

export function parseDesignUploadedAsset(input: unknown): DesignUploadedAsset {
  const value = z
    .object({
      file: z.string(),
      mimeType: z.string(),
      data: z.string().max(MAX_BASE64),
    })
    .strict()
    .parse(input);
  const bytes = decodeImage(value.data, value.mimeType);
  if (value.file !== assetFile(bytes, value.mimeType))
    throw new Error("Invalid Design upload recovery identity.");
  return value;
}

// Engine-minted request scope. No IPC caller can supply a repository option or
// arm another transaction, and ordinary Local commits continue to use V1.
const uploads = new AsyncLocalStorage<DesignUploadedAsset>();
export const currentDesignAssetUpload = () => uploads.getStore();
export function withDesignAssetUpload<T>(
  asset: DesignUploadedAsset,
  run: () => Promise<T>,
): Promise<T> {
  return uploads.run(asset, run);
}

function relativeAsset(root: string, asset: DesignUploadedAsset): string {
  return `${designDirectoryNameFor(root)}/${asset.file}`;
}

/** Content-addressed uploads can reuse identical bytes, never replace source.
 * Bounded descriptor reads reject links, aliases and concurrent replacement. */
export function assertDesignAssetUploadTarget(
  root: string,
  asset: DesignUploadedAsset,
): boolean {
  const target = assertSafeDesignStoragePath(root, relativeAsset(root, asset));
  let fd: number;
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const info = fs.fstatSync(fd);
    const expected = Buffer.from(asset.data, "base64");
    if (!info.isFile() || info.nlink !== 1 || info.size !== expected.length)
      throw new Error(
        "The upload asset already exists with different contents.",
      );
    const bytes = Buffer.alloc(expected.length + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    const current = fs.lstatSync(
      assertSafeDesignStoragePath(root, relativeAsset(root, asset)),
    );
    if (
      current.ino !== info.ino ||
      current.dev !== info.dev ||
      size !== expected.length ||
      !bytes.subarray(0, size).equals(expected)
    )
      throw new Error("The upload asset changed. Refresh before editing.");
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/** Called only after the checked document journal is durable. An exclusive
 * link publishes the complete, fsynced image without ever overwriting a file.
 * The retained journal recovers both an interrupted upload and its HTML edit. */
export function publishDesignUploadedAsset(
  root: string,
  asset: DesignUploadedAsset,
): void {
  // A crash after link but before unlink leaves two links to our complete
  // inode. Only the journal's deterministic temporary may be retired here.
  const relative = relativeAsset(root, asset);
  const temporaryRelative = `${path.posix.dirname(relative)}/.${path.posix.basename(relative)}.zeros-tmp`;
  const parentProbe = assertSafeDesignStoragePath(
    root,
    `${path.posix.dirname(relative)}/.zeros-upload-probe`,
  );
  const temporaryTarget = path.join(
    path.dirname(parentProbe),
    path.posix.basename(temporaryRelative),
  );
  const interrupted = fs.lstatSync(temporaryTarget, { throwIfNoEntry: false });
  if (interrupted) {
    const destination = fs.lstatSync(
      path.join(path.dirname(parentProbe), path.posix.basename(relative)),
      { throwIfNoEntry: false },
    );
    if (
      !interrupted.isFile() ||
      !(
        interrupted.nlink === 1 ||
        (interrupted.nlink === 2 &&
          destination?.isFile() &&
          destination.dev === interrupted.dev &&
          destination.ino === interrupted.ino)
      )
    )
      throw new Error("Unsafe Design upload temporary. Recovery is paused.");
    fs.unlinkSync(temporaryTarget);
    syncDesignStorageDirectory(path.dirname(temporaryTarget));
  }
  if (assertDesignAssetUploadTarget(root, asset)) return;
  const target = assertSafeDesignStoragePath(
    root,
    relativeAsset(root, asset),
    true,
  );
  const parent = path.dirname(target);
  const parentFd = fs.openSync(
    parent,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  const prefix =
    process.platform === "linux" ? `/proc/self/fd/${parentFd}` : parent;
  const temporary = path.join(prefix, path.basename(temporaryTarget));
  const assertParent = () => {
    if (
      fs.realpathSync(prefix) !== parent ||
      assertSafeDesignStoragePath(root, relativeAsset(root, asset)) !== target
    )
      throw new Error("The upload directory changed. Recovery is paused.");
  };
  try {
    assertParent();
    publishCloudWorkspacePath(parent, parentFd);
    const fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, Buffer.from(asset.data, "base64"));
      publishCloudWorkspacePath(
        path.join(parent, path.basename(temporary)),
        fd,
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    assertParent();
    try {
      fs.linkSync(temporary, path.join(prefix, path.basename(target)));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !assertDesignAssetUploadTarget(root, asset)
      )
        throw error;
    }
    fs.unlinkSync(temporary);
    fs.fsyncSync(parentFd);
    syncDesignStorageDirectory(path.dirname(parent));
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* no unpublished temporary */
    }
    fs.closeSync(parentFd);
  }
}
