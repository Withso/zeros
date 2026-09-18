import { designEvidenceBudget } from "./evidence-budget";
import { lstatSync } from "node:fs";
import { withDesignWorkspaceMutation } from "./document-write-lock";
import { assertDesignWriteAuthorized } from "./write-authority";
import { createHash } from "node:crypto";
import { opendir, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  designPrivateStorageDirectory,
  writePrivateDesignState,
} from "./metadata";
import { readSafeRegularFile } from "./safe-files";

export const DESIGN_RESULT_MAX_BYTES = 32 * 1024 * 1024;
export const DESIGN_RESULT_STORE_BYTES = 64 * 1024 * 1024;
export const DESIGN_RESULT_LIMIT = 16;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const id = z.string().regex(/^[a-f0-9]{64}$/);
const artifactName = z.enum([
  "source.json",
  "before.html",
  "after.html",
  "before.png",
  "after.png",
]);
export type DesignResultArtifactName = z.infer<typeof artifactName>;
const artifact = z
  .object({
    mimeType: z.enum(["application/json", "text/html", "image/png"]),
    encoding: z.enum(["utf8", "base64"]),
    sha256: id,
    bytes: z.number().int().min(0).max(DESIGN_RESULT_MAX_BYTES),
  })
  .strict();
export const designResultManifestSchema = z
  .object({
    version: z.literal(1),
    id,
    directoryId: z.string().max(128),
    actorId: z.string().max(128),
    requestId: z.string().max(128),
    proposalId: z.string().max(128).nullable(),
    proposalSignature: id.nullable(),
    createdAt: z.number().int().nonnegative(),
    documentId: z.string().max(260),
    baseRevision: z.string().max(128),
    revision: z.string().max(128),
    viewport: z
      .object({
        width: z.number().int().min(1).max(2048),
        height: z.number().int().min(1).max(2048),
        deviceScaleFactor: z.literal(1),
      })
      .strict(),
    fidelity: z.literal("authored-sanitized"),
    validation: z.enum(["source-snapshot", "semantic-dry-run"]),
    renderer: z.string().max(128).nullable(),
    artifacts: z.partialRecord(artifactName, artifact),
  })
  .strict();
export type DesignResultManifest = z.infer<typeof designResultManifestSchema>;
const bundleSchema = z
  .object({
    manifest: designResultManifestSchema,
    content: z.partialRecord(
      artifactName,
      z.string().max(DESIGN_RESULT_MAX_BYTES),
    ),
  })
  .strict();
export type DesignResultBundle = z.infer<typeof bundleSchema>;
const indexSchema = z
  .array(
    z
      .object({
        manifest: designResultManifestSchema,
        bytes: z.number().int().positive().max(DESIGN_RESULT_MAX_BYTES),
      })
      .strict(),
  )
  .max(DESIGN_RESULT_LIMIT);
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** Bounded private evidence, never written into the source worktree. The
 * writer takes a short workspace mutation lane. Eviction is explicit: an expired
 * result ID is unavailable and is never silently rendered from newer source. */
export class DesignResultStore {
  constructor(
    private readonly workspacePath: string,
    private readonly directoryId: string,
    private readonly now = Date.now,
  ) {}
  private async index() {
    const root = designPrivateStorageDirectory(this.workspacePath);
    const file = await readSafeRegularFile(
      root,
      path.join(root, "results.json"),
      256 * 1024,
    );
    if (!file) {
      if (lstatSync(path.join(root, "results.json"), { throwIfNoEntry: false }))
        throw new Error(
          "Design evidence index is unsafe or exceeds its byte limit.",
        );
      return [];
    }
    const entries = indexSchema.parse(JSON.parse(file.body.toString("utf8")));
    if (
      new Set(entries.map((entry) => entry.manifest.id)).size !==
        entries.length ||
      entries.reduce((sum, entry) => sum + entry.bytes, 0) >
        DESIGN_RESULT_STORE_BYTES
    )
      throw new Error(
        "Design evidence index exceeds its identity or storage limit.",
      );
    return entries;
  }
  async list(actorId?: string): Promise<DesignResultManifest[]> {
    return (await this.index())
      .map((entry) => entry.manifest)
      .filter(
        (manifest) =>
          manifest.directoryId === this.directoryId &&
          (!actorId || manifest.actorId === actorId) &&
          this.now() - manifest.createdAt <= RETENTION_MS,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async read(resultId: string, actorId?: string): Promise<DesignResultBundle> {
    return designEvidenceBudget.run(() => this.readBounded(resultId, actorId));
  }
  private async readBounded(
    resultId: string,
    actorId?: string,
  ): Promise<DesignResultBundle> {
    id.parse(resultId);
    const known = (await this.list(actorId)).find(
      (manifest) => manifest.id === resultId,
    );
    if (!known)
      throw new Error(
        "Design evidence expired or is unavailable for this owner.",
      );
    const root = designPrivateStorageDirectory(this.workspacePath);
    const file = await readSafeRegularFile(
      root,
      path.join(root, `result-${resultId}.json`),
      DESIGN_RESULT_MAX_BYTES,
    );
    if (!file)
      throw new Error("Design evidence is missing or exceeds its byte limit.");
    const bundle = bundleSchema.parse(JSON.parse(file.body.toString("utf8")));
    if (JSON.stringify(bundle.manifest) !== JSON.stringify(known))
      throw new Error(
        "Design evidence manifest does not match its retained identity.",
      );
    verifyBundle(bundle);
    return bundle;
  }
  async write(input: DesignResultBundle): Promise<DesignResultManifest> {
    return withDesignWorkspaceMutation(this.workspacePath, () =>
      this.writeLocked(input),
    );
  }
  private async writeLocked(
    input: DesignResultBundle,
  ): Promise<DesignResultManifest> {
    assertDesignWriteAuthorized();
    const bundle = bundleSchema.parse(input);
    verifyBundle(bundle);
    if (bundle.manifest.directoryId !== this.directoryId)
      throw new Error("Design evidence belongs to another directory.");
    const source = JSON.stringify(bundle);
    const size = Buffer.byteLength(source);
    if (size > DESIGN_RESULT_MAX_BYTES)
      throw new Error(
        "Design result exceeds its 32 MiB storage limit. Use a smaller document or capture.",
      );
    const previous = await this.index();
    const duplicate = previous.find(
      (entry) => entry.manifest.id === bundle.manifest.id,
    );
    if (duplicate) {
      if (JSON.stringify(await this.read(bundle.manifest.id)) !== source)
        throw new Error("Design result ID was reused with different evidence.");
      return duplicate.manifest;
    }
    const retained = previous
      .filter((entry) => this.now() - entry.manifest.createdAt <= RETENTION_MS)
      .sort((a, b) => a.manifest.createdAt - b.manifest.createdAt);
    let bytes = retained.reduce((sum, entry) => sum + entry.bytes, 0);
    while (
      retained.length >= DESIGN_RESULT_LIMIT ||
      bytes + size > DESIGN_RESULT_STORE_BYTES
    )
      bytes -= retained.shift()!.bytes;
    const live = new Set(retained.map((entry) => entry.manifest.id));
    // Remove retired data before the new write so disk usage stays bounded
    // even at the limit. A crash can make an old cache entry unavailable; it
    // cannot produce a receipt or image for a different source revision.
    for (const entry of previous)
      if (!live.has(entry.manifest.id))
        await unlink(
          path.join(
            designPrivateStorageDirectory(this.workspacePath),
            `result-${entry.manifest.id}.json`,
          ),
        ).catch(() => {});
    writePrivateDesignState(
      this.workspacePath,
      `result-${bundle.manifest.id}.json`,
      source,
    );
    retained.push({ manifest: bundle.manifest, bytes: size });
    writePrivateDesignState(
      this.workspacePath,
      "results.json",
      JSON.stringify(retained),
    );
    live.add(bundle.manifest.id);
    // Reclaim files left between an immutable artifact write and index publish.
    const directory = await opendir(
      designPrivateStorageDirectory(this.workspacePath),
    );
    let examined = 0;
    for await (const entry of directory) {
      if (++examined > 4096) break;
      const match = /^result-([a-f0-9]{64})\.json$/.exec(entry.name);
      if (match && !live.has(match[1]!))
        await unlink(
          path.join(
            designPrivateStorageDirectory(this.workspacePath),
            entry.name,
          ),
        ).catch(() => {});
    }
    return bundle.manifest;
  }
}

export function designResultArtifact(
  data: string | Uint8Array,
  mimeType: "application/json" | "text/html" | "image/png",
) {
  const bytes =
    typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  return {
    data:
      mimeType === "image/png"
        ? bytes.toString("base64")
        : bytes.toString("utf8"),
    metadata: {
      mimeType,
      encoding:
        mimeType === "image/png" ? ("base64" as const) : ("utf8" as const),
      sha256: sha256(bytes),
      bytes: bytes.length,
    },
  };
}

function verifyBundle(bundle: DesignResultBundle): void {
  if (
    Object.keys(bundle.content).length !==
    Object.keys(bundle.manifest.artifacts).length
  )
    throw new Error("Design evidence artifact inventory is incomplete.");
  for (const [name, meta] of Object.entries(bundle.manifest.artifacts)) {
    const data = bundle.content[name as DesignResultArtifactName];
    if (data === undefined) throw new Error("Design evidence is incomplete.");
    const bytes = Buffer.from(
      data,
      meta.encoding === "base64" ? "base64" : "utf8",
    );
    if (
      bytes.length !== meta.bytes ||
      sha256(bytes) !== meta.sha256 ||
      (meta.encoding === "base64" && bytes.toString("base64") !== data)
    )
      throw new Error("Design evidence hash verification failed.");
  }
}
