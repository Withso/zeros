import { z } from "zod";
import {
  designFrameFileSchema,
  isDesignPageFolder,
  portableDesignName,
} from "./design-path";
import { designPageIdSchema } from "./design-pages";

export const DESIGN_CATALOG_READ_CAPABILITY = "design.catalog.read.v1";
export const DESIGN_CATALOG_READ_OPERATION = "design.catalog.read";
export const DESIGN_CATALOG_BATCH_ENTRIES = 256;
export const DESIGN_CATALOG_BATCH_BYTES = 256 * 1024;
export const DESIGN_CATALOG_DESCRIPTOR_LIMIT = 10_000;

const identity = z.string().min(1).max(4096);
const directoryId = z.string().regex(/^design_[A-Za-z0-9_-]{1,64}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(DESIGN_CATALOG_DESCRIPTOR_LIMIT);
const intent = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const cursor = z.string().min(1).max(256);

export const designCatalogReadSchema = z
  .object({
    version: z.literal(1),
    workspaceId: identity,
    directoryId,
    intent,
    cursor: cursor.optional(),
    limit: z.number().int().min(1).max(DESIGN_CATALOG_BATCH_ENTRIES).optional(),
  })
  .strict();

export const designCatalogOwnerSchema = z
  .object({
    workspaceId: identity,
    directoryId,
    organizationId: z.string().min(1).max(128).nullable(),
    placement: z.enum(["local", "cloud"]),
  })
  .strict()
  .refine(
    (owner) => owner.placement !== "cloud" || owner.organizationId !== null,
  );

export const designCatalogPageSchema = z
  .object({
    id: designPageIdSchema,
    title: z.string().max(120),
    folder: z
      .string()
      .refine((value) => value === "" || isDesignPageFolder(value)),
    count,
  })
  .strict();

export const designCatalogFrameSchema = z
  .object({
    id: designPageIdSchema,
    pageId: designPageIdSchema,
    source: designFrameFileSchema.pipe(z.string().max(4096)),
    title: z.string().max(120),
    kind: z.enum(["html", "text"]),
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000),
    width: z.number().finite().min(1).max(16_384),
    height: z.number().finite().min(1).max(16_384),
    z: z.number().int().min(0).max(256),
    order: count,
    preparation: z.literal("unprepared"),
  })
  .strict();

export const designCatalogFailureSchema = z
  .object({
    kind: z.literal("design-catalog"),
    version: z.literal(1),
    status: z.literal("unavailable"),
    reason: z.enum([
      "expired",
      "stale",
      "superseded",
      "unsettled",
      "unsupported-layout",
      "too-large",
      "busy",
      "authority-lost",
    ]),
  })
  .strict();

export const designCatalogBatchSchema = z
  .object({
    kind: z.literal("design-catalog"),
    version: z.literal(1),
    status: z.literal("ready"),
    owner: designCatalogOwnerSchema,
    binding: revision,
    revision,
    intent,
    pages: z.array(designCatalogPageSchema).min(1).max(64),
    total: count,
    offset: count,
    frames: z.array(designCatalogFrameSchema).max(DESIGN_CATALOG_BATCH_ENTRIES),
    coverage: z.enum(["complete", "partial"]),
    nextCursor: cursor.nullable(),
  })
  .strict()
  .superRefine((batch, ctx) => {
    const end = batch.offset + batch.frames.length;
    const complete = batch.offset === 0 && end === batch.total;
    let start = 0;
    const pages = new Map(
      batch.pages.map((page) => {
        const entry = { ...page, start };
        start += page.count;
        return [page.id, entry] as const;
      }),
    );
    if (
      end > batch.total ||
      (batch.total > 0 && batch.frames.length === 0) ||
      (batch.nextCursor === null) !== (end === batch.total) ||
      batch.coverage !== (complete ? "complete" : "partial") ||
      batch.pages.reduce((total, page) => total + page.count, 0) !==
        batch.total ||
      pages.size !== batch.pages.length ||
      new Set(batch.pages.map((page) => portableDesignName(page.folder)))
        .size !== batch.pages.length ||
      (batch.pages.length > 1 &&
        batch.pages.some((page) => page.folder === "")) ||
      new Set(batch.frames.map((frame) => frame.id)).size !==
        batch.frames.length ||
      new Set(batch.frames.map((frame) => portableDesignName(frame.source)))
        .size !== batch.frames.length ||
      batch.frames.some((frame, index) => {
        const page = pages.get(frame.pageId);
        return (
          !page ||
          frame.order >= page.count ||
          page.start + frame.order !== batch.offset + index ||
          (page.folder
            ? frame.source.split("/")[0] !== page.folder
            : frame.source.includes("/"))
        );
      })
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid Design catalog coverage or membership.",
      });
    if (
      new TextEncoder().encode(JSON.stringify(batch)).byteLength >
      DESIGN_CATALOG_BATCH_BYTES
    )
      ctx.addIssue({
        code: "custom",
        message: "Design catalog batch exceeds its byte limit.",
      });
  });

export const designCatalogReplySchema = z.union([
  designCatalogBatchSchema,
  designCatalogFailureSchema,
]);
export type DesignCatalogRead = z.infer<typeof designCatalogReadSchema>;
export type DesignCatalogOwner = z.infer<typeof designCatalogOwnerSchema>;
export type DesignCatalogPage = z.infer<typeof designCatalogPageSchema>;
export type DesignCatalogFrame = z.infer<typeof designCatalogFrameSchema>;
export type DesignCatalogBatch = z.infer<typeof designCatalogBatchSchema>;
export type DesignCatalogFailure = z.infer<typeof designCatalogFailureSchema>;
export type DesignCatalogReply = z.infer<typeof designCatalogReplySchema>;
/** Local navigation and bounded authoritative preparation; opt in only after
 * capability negotiation. Catalog revisions never stand in for source hashes. */
export const DESIGN_LAZY_PREPARATION_CAPABILITY = "design.preparation.v1";
export const designNavigationReadSchema = z.object({ workspaceId: z.string().min(1).max(4096) }).strict();
export const designFramesPrepareSchema = z.object({
  workspaceId: z.string().min(1).max(4096),
  directoryId: z.string().regex(/^design_[A-Za-z0-9_-]{1,64}$/),
  catalogRevision: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(designFrameFileSchema).min(1).max(16).refine((files) => new Set(files).size === files.length),
  /** Only requested after design.source-surfaces.v1 capability negotiation. */
  surfaceCosts: z.literal(true).optional(),
}).strict();

export const designPreparedFrameSchema = designCatalogFrameSchema.pick({
  title: true, x: true, y: true, width: true, height: true, z: true,
}).extend({
  file: designFrameFileSchema,
  frameId: designPageIdSchema,
  pageId: designPageIdSchema,
  kind: z.enum(["frame", "text"]),
  nodeCount: z.number().int().nonnegative(),
  layerCount: z.number().int().nonnegative().optional(),
  modifiedAt: z.number().finite().nonnegative(),
  sourceVersion: z.string().regex(/^[a-f0-9]{24}$/),
  surfaceCost: z.object({
    sourceBytes: z.number().int().positive().max(1024 * 1024),
    nodes: z.number().int().positive(),
    imageBytes: z.number().int().nonnegative(),
  }).strict().nullable().optional(),
}).strict();
export const designFramesPrepareReplySchema = z.object({
  directoryId,
  catalogRevision: revision,
  frames: z.array(designPreparedFrameSchema).max(16),
  errors: z.array(z.object({ file: designFrameFileSchema, message: z.string().max(16_384) }).strict()).max(16),
}).strict();
