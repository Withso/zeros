// Generated from Withso/zeros 2435964e1bdde90623da1042449a6438131f5582 (MIT). Do not edit.
// See previous-design-limits.provenance.json for source hashes.
/* eslint-disable -- Preserve the frozen previous codec. */
// previous:apps/desktop/src/engine/design/canvas-file.ts
import { createHash } from "node:crypto";
import { z as z2 } from "zod";

// previous:packages/protocol/src/design-path.ts
import { z } from "zod";
var flatFrame = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/i;
var pageFolder = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var reservedFolders = /* @__PURE__ */ new Set(["meta", "assets", "components"]);
function isDesignPageFolder(value) {
  return typeof value === "string" && pageFolder.test(value) && !value.endsWith(".") && !reservedFolders.has(portableDesignName(value));
}
function designPageFolderProblem(value) {
  if (isDesignPageFolder(value)) return null;
  const folder = typeof value === "string" ? value : String(value);
  if (typeof value === "string" && pageFolder.test(value) && !value.endsWith(".") && reservedFolders.has(portableDesignName(value))) {
    return `Design page folder "${folder}" is reserved: meta, assets and components hold shared Design files in any letter case. Use another folder, such as "${portableDesignName(value)}-2".`;
  }
  return `Design page folder ${JSON.stringify(folder)} must be one portable segment: 1-64 letters, digits, dots, underscores or hyphens, starting with a letter or digit and not ending in a dot.`;
}
function isDesignFrameFile(value) {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  return parts.length === 1 ? flatFrame.test(value) : parts.length === 2 && isDesignPageFolder(parts[0]) && flatFrame.test(parts[1]);
}
function portableDesignName(value) {
  return value.normalize("NFC").toLowerCase();
}
var designFrameFileSchema = z.string().refine(isDesignFrameFile, "Invalid Design frame file.");

// previous:apps/desktop/src/engine/design/canvas-file.ts
var id = z2.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/);
var title = z2.string().max(120);
var source = designFrameFileSchema;
var coordinate = z2.number().finite().min(-1e6).max(1e6);
var size = z2.number().finite().min(1).max(16384);
var frameSchema = z2.object({
  kind: z2.enum(["html", "text"]),
  source,
  title,
  x: coordinate,
  y: coordinate,
  width: size,
  height: size,
  z: z2.number().int().min(0).max(256).optional(),
  geometryMetadata: z2.record(z2.string(), z2.unknown()).optional()
}).passthrough();
var pageSchema = z2.object({
  id,
  title,
  frames: z2.array(id).max(256)
}).passthrough();
var canvasSchema = z2.object({
  version: z2.literal(1),
  id: id.default("main"),
  title: title.default("Design"),
  pages: z2.array(pageSchema).length(1).optional(),
  frames: z2.record(id, frameSchema).refine((frames) => Object.keys(frames).length <= 256)
}).passthrough();
var PAGE_FOLDER_ISSUE = "zeros-design-page-folder";
var pageFolderSchema = z2.string().superRefine((folder, context) => {
  const problem = designPageFolderProblem(folder);
  if (problem)
    context.addIssue({
      code: "custom",
      message: problem,
      params: { kind: PAGE_FOLDER_ISSUE }
    });
});
var pagedCanvasSchema = canvasSchema.extend({
  version: z2.literal(2),
  pages: z2.array(pageSchema.extend({ folder: pageFolderSchema })).min(1).max(64)
});
var record = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Design canvas metadata must contain objects.");
  return value;
};
function decodeCanvasFile(source2, options) {
  const value = JSON.parse(source2);
  if (value?.version !== 1 && value?.version !== 2)
    throw new Error(`Unsupported design canvas version: ${value?.version}`);
  if (options && options.version !== value.version)
    throw new Error(`Design layout requires canvas version ${options.version}; found ${value.version}.`);
  const result = (value.version === 2 ? pagedCanvasSchema : canvasSchema).safeParse(value);
  if (!result.success) {
    const folders = result.error.issues.filter(
      (issue) => issue.code === "custom" && issue.params?.kind === PAGE_FOLDER_ISSUE
    );
    if (folders.length > 0)
      throw new Error(
        `Invalid Design canvas page folder: ${folders.map((issue) => issue.message).join(" ")}`
      );
    throw new Error(
      `Invalid Design canvas frame geometry or metadata: ${result.error.message}`
    );
  }
  const parsed = result.data;
  const {
    frames,
    pages = [{ id: "main", title: "Design", frames: Object.keys(frames) }],
    ...rest
  } = parsed;
  const order = pages.flatMap((page) => page.frames);
  if (parsed.version === 2 && (new Set(pages.map((page) => page.id)).size !== pages.length || new Set(pages.map((page) => portableDesignName(String(page.folder)))).size !== pages.length))
    throw new Error("Design pages must have distinct IDs and folders.");
  if (new Set(order).size !== order.length || order.length !== Object.keys(frames).length || order.some((frameId) => !Object.hasOwn(frames, frameId)))
    throw new Error(
      "Every Design frame must appear exactly once on a canvas page."
    );
  const files = /* @__PURE__ */ new Set();
  const geometry = {};
  const info = {};
  for (const [frameId, frame] of Object.entries(frames)) {
    const {
      source: file,
      kind,
      title: title2,
      x,
      y,
      width,
      height,
      z: z5,
      geometryMetadata,
      ...extensions
    } = frame;
    const page = pages.find((page2) => page2.frames.includes(frameId));
    if (parsed.version === 1 ? file.includes("/") : file.split("/")[0] !== page.folder || file.split("/").length !== 2)
      throw new Error("Design frame source must be inside its page folder.");
    const portable = portableDesignName(file);
    if (files.has(portable))
      throw new Error("Design frames must have distinct source files.");
    files.add(portable);
    geometry[file] = {
      ...geometryMetadata,
      x,
      y,
      w: width,
      h: height,
      z: z5 ?? page.frames.indexOf(frameId)
    };
    info[file] = {
      ...extensions,
      id: frameId,
      title: title2,
      kind: kind === "text" ? "text" : "frame"
    };
  }
  return { ...rest, version: 3, pages, frames: geometry, frame_info: info };
}
function legacyFrameId(file) {
  return `frame_${createHash("sha256").update(file).digest("hex").slice(0, 24)}`;
}
function encodeCanvasFile(document, options = { version: 1 }) {
  if (document.version !== void 0 && ![1, 2, 3].includes(document.version))
    throw new Error(`Unsupported design canvas version: ${document.version}`);
  const {
    version: _version,
    frames,
    frame_info,
    view: _view,
    pages,
    ...rest
  } = document;
  const pagedPages = options.version === 2 ? pagedCanvasSchema.shape.pages.parse(pages) : void 0;
  const pageOrder = pagedPages && new Map(pagedPages.flatMap(
    (page) => page.frames.map((frameId, index) => [frameId, index])
  ));
  const information = frame_info === void 0 ? {} : record(frame_info);
  const geometryFor = (value) => {
    if (document.version === 3) return record(value);
    const old = value && typeof value === "object" && !Array.isArray(value) ? record(value) : {};
    const bounded = (value2, fallback, min, max) => typeof value2 === "number" && Number.isFinite(value2) ? Math.min(max, Math.max(min, value2)) : fallback;
    return {
      ...old,
      x: bounded(old.x, 0, -1e6, 1e6),
      y: bounded(old.y, 0, -1e6, 1e6),
      w: bounded(old.w, 1440, 1, 16384),
      h: bounded(old.h, 900, 1, 16384),
      z: Math.round(bounded(old.z, 0, 0, 256))
    };
  };
  const entries = Object.entries(record(frames === void 0 ? {} : frames)).map(([file, geometry]) => [file, geometryFor(geometry)]).sort(([, left], [, right]) => Number(left.z ?? 0) - Number(right.z ?? 0));
  if (Object.keys(information).some(
    (file) => !entries.some(([source2]) => source2 === file)
  ))
    throw new Error("Invalid Design frame information reference.");
  const authored = {};
  for (const [file, value] of entries) {
    const geometry = record(value);
    const { x: _x, y: _y, w: _w, h: _h, z: _z, ...geometryMetadata } = geometry;
    const {
      id: suppliedId,
      title: suppliedTitle,
      kind,
      ...extensions
    } = record(information[file] ?? {});
    if (kind !== void 0 && kind !== "frame" && kind !== "text")
      throw new Error("Unsupported legacy Design frame kind.");
    const frameId = suppliedId === void 0 ? legacyFrameId(file) : id.parse(suppliedId);
    if (Object.hasOwn(authored, frameId))
      throw new Error("Duplicate Design frame identity.");
    authored[frameId] = frameSchema.parse({
      ...extensions,
      kind: kind === "text" ? "text" : "html",
      source: file,
      title: suppliedTitle ?? file.replace(/\.html$/i, ""),
      x: geometry.x,
      y: geometry.y,
      width: geometry.w,
      height: geometry.h,
      ...geometry.z !== (pageOrder?.get(frameId) ?? Object.keys(authored).length) ? { z: geometry.z } : {},
      ...Object.keys(geometryMetadata).length ? { geometryMetadata } : {}
    });
  }
  const outputPages = options.version === 2 ? pagedPages : [{ ...pages === void 0 ? { id: "main", title: "Design" } : z2.array(pageSchema).length(1).parse(pages)[0], frames: Object.keys(authored) }];
  const result = (options.version === 2 ? pagedCanvasSchema : canvasSchema).parse({
    ...rest,
    version: options.version,
    pages: outputPages,
    frames: authored
  });
  const sourceText = JSON.stringify(result, null, 2) + "\n";
  decodeCanvasFile(sourceText);
  return sourceText;
}

// previous:packages/protocol/src/design-pages.ts
import { z as z3 } from "zod";
var designPageIdSchema = z3.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/, "Invalid Design page ID.");
var designPageTitleSchema = z3.string().refine(
  (title2) => !/[\u0000-\u001f\u007f-\u009f]/.test(title2),
  "Page title must not contain control characters."
).transform((title2) => title2.trim()).pipe(
  z3.string().min(1, "Page title cannot be empty.").max(120, "Page title exceeds 120 characters.")
);
var designPageCreateInputSchema = z3.object({ title: designPageTitleSchema.optional() }).strict();
var designPageRenameInputSchema = z3.object({ pageId: designPageIdSchema, title: designPageTitleSchema }).strict();
var designPageDeleteInputSchema = z3.object({
  pageId: designPageIdSchema,
  expectedFrameIds: z3.array(designPageIdSchema).max(256).refine(
    (ids) => new Set(ids).size === ids.length,
    "Expected frame IDs must be distinct."
  )
}).strict();
var designPageCatalogSchema = z3.array(
  z3.object({
    id: designPageIdSchema,
    title: z3.string().max(120),
    folder: z3.string().refine((folder) => folder === "" || isDesignPageFolder(folder)),
    frameFiles: z3.array(designFrameFileSchema).max(256),
    frameIds: z3.array(designPageIdSchema).max(256).optional()
  })
).min(1).max(64).superRefine((pages, ctx) => {
  const ids = /* @__PURE__ */ new Set(), folders = /* @__PURE__ */ new Set(), files = /* @__PURE__ */ new Set(), frameIds = /* @__PURE__ */ new Set();
  for (const page of pages) {
    const folder = portableDesignName(page.folder);
    if (ids.has(page.id) || folders.has(folder) || page.folder === "" && pages.length > 1)
      ctx.addIssue({
        code: "custom",
        message: "Design pages must have distinct owners."
      });
    ids.add(page.id);
    folders.add(folder);
    if (page.frameIds) {
      if (page.frameIds.length !== page.frameFiles.length)
        ctx.addIssue({
          code: "custom",
          message: "Design page frame IDs must match its files."
        });
      for (const id2 of page.frameIds) {
        if (frameIds.has(id2))
          ctx.addIssue({
            code: "custom",
            message: "Design frame IDs must be distinct."
          });
        frameIds.add(id2);
      }
    }
    for (const file of page.frameFiles) {
      const portable = portableDesignName(file);
      if (files.has(portable) || (page.folder ? !file.startsWith(`${page.folder}/`) : file.includes("/")))
        ctx.addIssue({
          code: "custom",
          message: "Design page frame membership is invalid."
        });
      files.add(portable);
    }
  }
  if (files.size > 256)
    ctx.addIssue({
      code: "custom",
      message: "Design exceeds the directory-wide frame limit."
    });
});

// previous:packages/protocol/src/design-catalog.ts
import { z as z4 } from "zod";
var DESIGN_CATALOG_BATCH_ENTRIES = 256;
var DESIGN_CATALOG_BATCH_BYTES = 256 * 1024;
var DESIGN_CATALOG_DESCRIPTOR_LIMIT = 1e4;
var identity = z4.string().min(1).max(4096);
var directoryId = z4.string().regex(/^design_[A-Za-z0-9_-]{1,64}$/);
var revision = z4.string().regex(/^[a-f0-9]{64}$/);
var count = z4.number().int().min(0).max(DESIGN_CATALOG_DESCRIPTOR_LIMIT);
var intent = z4.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
var cursor = z4.string().min(1).max(256);
var designCatalogReadSchema = z4.object({
  version: z4.literal(1),
  workspaceId: identity,
  directoryId,
  intent,
  cursor: cursor.optional(),
  limit: z4.number().int().min(1).max(DESIGN_CATALOG_BATCH_ENTRIES).optional()
}).strict();
var designCatalogOwnerSchema = z4.object({
  workspaceId: identity,
  directoryId,
  organizationId: z4.string().min(1).max(128).nullable(),
  placement: z4.enum(["local", "cloud"])
}).strict().refine(
  (owner) => owner.placement !== "cloud" || owner.organizationId !== null
);
var designCatalogPageSchema = z4.object({
  id: designPageIdSchema,
  title: z4.string().max(120),
  folder: z4.string().refine((value) => value === "" || isDesignPageFolder(value)),
  count
}).strict();
var designCatalogFrameSchema = z4.object({
  id: designPageIdSchema,
  pageId: designPageIdSchema,
  source: designFrameFileSchema.pipe(z4.string().max(4096)),
  title: z4.string().max(120),
  kind: z4.enum(["html", "text"]),
  x: z4.number().finite().min(-1e6).max(1e6),
  y: z4.number().finite().min(-1e6).max(1e6),
  width: z4.number().finite().min(1).max(16384),
  height: z4.number().finite().min(1).max(16384),
  z: z4.number().int().min(0).max(256),
  order: count,
  preparation: z4.literal("unprepared")
}).strict();
var designCatalogFailureSchema = z4.object({
  kind: z4.literal("design-catalog"),
  version: z4.literal(1),
  status: z4.literal("unavailable"),
  reason: z4.enum([
    "expired",
    "stale",
    "superseded",
    "unsettled",
    "unsupported-layout",
    "too-large",
    "busy",
    "authority-lost"
  ])
}).strict();
var designCatalogBatchSchema = z4.object({
  kind: z4.literal("design-catalog"),
  version: z4.literal(1),
  status: z4.literal("ready"),
  owner: designCatalogOwnerSchema,
  binding: revision,
  revision,
  intent,
  pages: z4.array(designCatalogPageSchema).min(1).max(64),
  total: count,
  offset: count,
  frames: z4.array(designCatalogFrameSchema).max(DESIGN_CATALOG_BATCH_ENTRIES),
  coverage: z4.enum(["complete", "partial"]),
  nextCursor: cursor.nullable()
}).strict().superRefine((batch, ctx) => {
  const end = batch.offset + batch.frames.length;
  const complete = batch.offset === 0 && end === batch.total;
  let start = 0;
  const pages = new Map(
    batch.pages.map((page) => {
      const entry = { ...page, start };
      start += page.count;
      return [page.id, entry];
    })
  );
  if (end > batch.total || batch.total > 0 && batch.frames.length === 0 || batch.nextCursor === null !== (end === batch.total) || batch.coverage !== (complete ? "complete" : "partial") || batch.pages.reduce((total, page) => total + page.count, 0) !== batch.total || pages.size !== batch.pages.length || new Set(batch.pages.map((page) => portableDesignName(page.folder))).size !== batch.pages.length || batch.pages.length > 1 && batch.pages.some((page) => page.folder === "") || new Set(batch.frames.map((frame) => frame.id)).size !== batch.frames.length || new Set(batch.frames.map((frame) => portableDesignName(frame.source))).size !== batch.frames.length || batch.frames.some((frame, index) => {
    const page = pages.get(frame.pageId);
    return !page || frame.order >= page.count || page.start + frame.order !== batch.offset + index || (page.folder ? frame.source.split("/")[0] !== page.folder : frame.source.includes("/"));
  }))
    ctx.addIssue({
      code: "custom",
      message: "Invalid Design catalog coverage or membership."
    });
  if (new TextEncoder().encode(JSON.stringify(batch)).byteLength > DESIGN_CATALOG_BATCH_BYTES)
    ctx.addIssue({
      code: "custom",
      message: "Design catalog batch exceeds its byte limit."
    });
});
var designCatalogReplySchema = z4.union([
  designCatalogBatchSchema,
  designCatalogFailureSchema
]);
var designMutationCatalogSchema = z4.object({
  revision,
  frames: z4.array(designCatalogFrameSchema).max(DESIGN_CATALOG_DESCRIPTOR_LIMIT)
}).strict();
var designNavigationReadSchema = z4.object({ workspaceId: z4.string().min(1).max(4096) }).strict();
var designFramesPrepareSchema = z4.object({
  workspaceId: z4.string().min(1).max(4096),
  directoryId: z4.string().regex(/^design_[A-Za-z0-9_-]{1,64}$/),
  catalogRevision: z4.string().regex(/^[a-f0-9]{64}$/),
  files: z4.array(designFrameFileSchema).min(1).max(16).refine((files) => new Set(files).size === files.length),
  /** Only requested after design.source-surfaces.v1 capability negotiation. */
  surfaceCosts: z4.literal(true).optional()
}).strict();
var designPreparedFrameSchema = designCatalogFrameSchema.pick({
  title: true,
  x: true,
  y: true,
  width: true,
  height: true,
  z: true
}).extend({
  file: designFrameFileSchema,
  frameId: designPageIdSchema,
  pageId: designPageIdSchema,
  kind: z4.enum(["frame", "text"]),
  nodeCount: z4.number().int().nonnegative(),
  layerCount: z4.number().int().nonnegative().optional(),
  modifiedAt: z4.number().finite().nonnegative(),
  sourceVersion: z4.string().regex(/^[a-f0-9]{24}$/),
  surfaceCost: z4.object({
    sourceBytes: z4.number().int().positive().max(1024 * 1024),
    nodes: z4.number().int().positive(),
    imageBytes: z4.number().int().nonnegative()
  }).strict().nullable().optional()
}).strict();
var designFramesPrepareReplySchema = z4.object({
  directoryId,
  catalogRevision: revision,
  frames: z4.array(designPreparedFrameSchema).max(16),
  errors: z4.array(z4.object({ file: designFrameFileSchema, message: z4.string().max(16384) }).strict()).max(16)
}).strict();
export {
  decodeCanvasFile,
  designCatalogFrameSchema,
  designPageCatalogSchema,
  encodeCanvasFile
};
