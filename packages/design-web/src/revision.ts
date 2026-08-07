import {
  canonicalDesignJson,
  designDocumentIdSchema,
  designFoundationManifestSchema,
  designRelativeFileSchema,
  migrateDesignFoundationManifest,
} from "@zeros/design-core";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  DESIGN_WEB_MAX_FILES,
  DESIGN_WEB_MAX_FILE_BYTES,
  DESIGN_WEB_MAX_TOTAL_BYTES,
  DESIGN_WEB_SCHEMA_VERSION,
  type DesignFrameGeometry,
  type DesignWebDocumentInput,
  type DesignWebDocumentState,
} from "./model";

interface DesignFileFingerprint {
  source: string;
  bytes: number;
  digest: string;
}

const fileFingerprintCache = new WeakMap<
  object,
  ReadonlyMap<string, DesignFileFingerprint>
>();
const canonicalDigestCache = new WeakMap<object, string>();

function hash96Bytes(bytes: Uint8Array): string {
  return [...sha256(bytes).subarray(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hash96(value: string): string {
  return hash96Bytes(new TextEncoder().encode(value));
}

function fingerprintSource(source: string): DesignFileFingerprint {
  const encoded = new TextEncoder().encode(source);
  return {
    source,
    bytes: encoded.byteLength,
    digest: hash96Bytes(encoded),
  };
}

function fileFingerprints(
  files: Readonly<Record<string, string>>,
  previousFiles?: Readonly<Record<string, string>>,
): ReadonlyMap<string, DesignFileFingerprint> {
  const retained = fileFingerprintCache.get(files);
  if (retained) return retained;
  const previous = previousFiles
    ? fileFingerprintCache.get(previousFiles)
    : undefined;
  const records = new Map<string, DesignFileFingerprint>();
  for (const [file, source] of Object.entries(files)) {
    const prior = previous?.get(file);
    records.set(
      file,
      prior?.source === source ? prior : fingerprintSource(source),
    );
  }
  fileFingerprintCache.set(files, records);
  return records;
}

function canonicalDigest(value: object): string {
  const retained = canonicalDigestCache.get(value);
  if (retained) return retained;
  const digest = hash96(canonicalDesignJson(value));
  canonicalDigestCache.set(value, digest);
  return digest;
}

/** Deterministic 96-bit authored-document revision. This is a conflict key,
 * not a security digest or the renderer's separate source generation. */
export function createDesignWebRevision(
  value: Omit<DesignWebDocumentState, "revision">,
): string {
  const fingerprints = fileFingerprints(value.files);
  const files = Object.keys(value.files)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((file) => {
      const fingerprint = fingerprints.get(file)!;
      return `${file.length}:${file}:${fingerprint.bytes}:${fingerprint.digest}`;
    })
    .join("\u0000");
  const payload = `${value.schemaVersion}\u0000${value.documentId}\u0000${value.entryFile}\u0000${files}\u0000${canonicalDigest(value.manifest)}\u0000${canonicalDigest(value.frames)}`;
  return hash96(payload);
}

function validateGeometry(
  frame: string,
  geometry: DesignFrameGeometry,
): DesignFrameGeometry {
  designRelativeFileSchema.parse(frame);
  const values = [
    geometry.x,
    geometry.y,
    geometry.width,
    geometry.height,
    geometry.z,
  ];
  if (
    !values.every(Number.isFinite) ||
    geometry.width <= 0 ||
    geometry.height <= 0
  ) {
    throw new Error(`Invalid frame geometry: ${frame}`);
  }
  if (!Number.isInteger(geometry.z) || geometry.z < 0) {
    throw new Error(`Invalid frame z-index: ${frame}`);
  }
  return { ...geometry };
}

export function createDesignWebDocumentState(
  input: DesignWebDocumentInput,
): DesignWebDocumentState {
  const documentId = designDocumentIdSchema.parse(input.documentId);
  const entryFile = designRelativeFileSchema.parse(input.entryFile);
  const entries = Object.entries(input.files);
  if (entries.length === 0 || entries.length > DESIGN_WEB_MAX_FILES) {
    throw new Error(
      `Design document must contain between 1 and ${DESIGN_WEB_MAX_FILES} files.`,
    );
  }
  let totalBytes = 0;
  const files: Record<string, string> = {};
  const fingerprints = new Map<string, DesignFileFingerprint>();
  for (const [rawFile, source] of entries) {
    const file = designRelativeFileSchema.parse(rawFile);
    if (typeof source !== "string")
      throw new Error(`Design source must be text: ${file}`);
    const fingerprint = fingerprintSource(source);
    const bytes = fingerprint.bytes;
    if (bytes > DESIGN_WEB_MAX_FILE_BYTES) {
      throw new Error(`Design source exceeds the per-file limit: ${file}`);
    }
    totalBytes += bytes;
    if (totalBytes > DESIGN_WEB_MAX_TOTAL_BYTES) {
      throw new Error("Design document exceeds the total source limit.");
    }
    files[file] = source;
    fingerprints.set(file, fingerprint);
  }
  fileFingerprintCache.set(files, fingerprints);
  if (
    files[entryFile] === undefined ||
    !entryFile.toLowerCase().endsWith(".html")
  ) {
    throw new Error(
      `Design entry file is missing or is not HTML: ${entryFile}`,
    );
  }
  const frames = Object.fromEntries(
    Object.entries(input.frames ?? {}).map(([frame, geometry]) => [
      frame,
      validateGeometry(frame, geometry),
    ]),
  );
  const base = {
    schemaVersion: DESIGN_WEB_SCHEMA_VERSION,
    documentId,
    entryFile,
    files,
    manifest: designFoundationManifestSchema.parse(
      migrateDesignFoundationManifest(input.manifest),
    ),
    frames,
  };
  return { ...base, revision: createDesignWebRevision(base) };
}

export function updateDesignWebState(
  state: DesignWebDocumentState,
  patch: Partial<Pick<DesignWebDocumentState, "files" | "manifest" | "frames">>,
): DesignWebDocumentState {
  const files = patch.files ?? state.files;
  if (patch.files) {
    const entries = Object.entries(files);
    if (entries.length === 0 || entries.length > DESIGN_WEB_MAX_FILES) {
      throw new Error(
        `Design document must contain between 1 and ${DESIGN_WEB_MAX_FILES} files.`,
      );
    }
    const fingerprints = fileFingerprints(files, state.files);
    let totalBytes = 0;
    for (const [file, source] of entries) {
      designRelativeFileSchema.parse(file);
      if (typeof source !== "string") {
        throw new Error(`Design source must be text: ${file}`);
      }
      const bytes = fingerprints.get(file)!.bytes;
      if (bytes > DESIGN_WEB_MAX_FILE_BYTES) {
        throw new Error(`Design source exceeds the per-file limit: ${file}`);
      }
      totalBytes += bytes;
      if (totalBytes > DESIGN_WEB_MAX_TOTAL_BYTES) {
        throw new Error("Design document exceeds the total source limit.");
      }
    }
    if (
      files[state.entryFile] === undefined ||
      !state.entryFile.toLowerCase().endsWith(".html")
    ) {
      throw new Error(
        `Design entry file is missing or is not HTML: ${state.entryFile}`,
      );
    }
  }
  const manifest = patch.manifest
    ? designFoundationManifestSchema.parse(patch.manifest)
    : state.manifest;
  const frames = patch.frames
    ? Object.fromEntries(
        Object.entries(patch.frames).map(([frame, geometry]) => [
          frame,
          validateGeometry(frame, geometry),
        ]),
      )
    : state.frames;
  const base = {
    schemaVersion: DESIGN_WEB_SCHEMA_VERSION,
    documentId: state.documentId,
    entryFile: state.entryFile,
    files,
    manifest,
    frames,
  };
  return { ...base, revision: createDesignWebRevision(base) };
}
