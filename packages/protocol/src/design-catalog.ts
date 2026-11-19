import { z } from "zod";
import {
  designFrameFileSchema,
  isDesignPageFolder,
  portableDesignName,
} from "./design-path";
import {
  DESIGN_MAX_FRAMES_PER_PAGE,
  DESIGN_MAX_PAGES,
  designPageIdSchema,
} from "./design-pages";

export const DESIGN_CATALOG_READ_CAPABILITY = "design.catalog.read.v1";
export const DESIGN_CATALOG_READ_OPERATION = "design.catalog.read";
export const DESIGN_CATALOG_BATCH_ENTRIES = 256;
export const DESIGN_CATALOG_BATCH_BYTES = 256 * 1024;
/** Wider batches reduce catalog revalidation and round trips; opt in only for engines advertising support. */
export const DESIGN_CATALOG_WIDE_BATCHES_CAPABILITY = "design.catalog.read.wide.v1";
export const DESIGN_CATALOG_WIDE_BATCH_ENTRIES = 4096;
export const DESIGN_CATALOG_WIDE_BATCH_BYTES = 1024 * 1024;
/** The descriptor limit covers every admissible directory; retention also has a byte budget. */
export const DESIGN_CATALOG_DESCRIPTOR_LIMIT =
  DESIGN_MAX_PAGES * DESIGN_MAX_FRAMES_PER_PAGE;

const identity = z.string().min(1).max(4096);
const directoryId = z.string().regex(/^design_[A-Za-z0-9_-]{1,64}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(DESIGN_CATALOG_DESCRIPTOR_LIMIT);
const pageCount = z.number().int().min(0).max(DESIGN_MAX_FRAMES_PER_PAGE);
const intent = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const cursor = z.string().min(1).max(256);

export const designCatalogReadSchema = z
  .object({
    version: z.literal(1),
    workspaceId: identity,
    directoryId,
    intent,
    cursor: cursor.optional(),
    limit: z.number().int().min(1).max(DESIGN_CATALOG_WIDE_BATCH_ENTRIES).optional(),
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
    count: pageCount,
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
    z: z.number().int().min(0).max(DESIGN_MAX_FRAMES_PER_PAGE),
    order: pageCount,
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
    pages: z.array(designCatalogPageSchema).min(1).max(DESIGN_MAX_PAGES),
    total: count,
    offset: count,
    frames: z.array(designCatalogFrameSchema).max(DESIGN_CATALOG_WIDE_BATCH_ENTRIES),
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
      DESIGN_CATALOG_WIDE_BATCH_BYTES
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
/** Negotiate this capability before lazy preparation; catalog revisions cannot replace source hashes. */
export const DESIGN_LAZY_PREPARATION_CAPABILITY = "design.preparation.v1";
export const DESIGN_COMPONENT_IDENTITY_CAPABILITY = "design.component-identity.v1";
export const DESIGN_COMPONENT_IDENTITY_PARAM = "includeComponentIdentity";
export const DESIGN_MUTATION_SNAPSHOTS_CAPABILITY = "design.mutation-snapshots.v1";
/** Only sources affected by the write are ready; prepare other sources before authorizing edits. */
export const designMutationCatalogSchema = z.object({
  revision,
  frames: z.array(designCatalogFrameSchema).max(DESIGN_CATALOG_DESCRIPTOR_LIMIT),
}).strict();
export type DesignMutationCatalog = z.infer<typeof designMutationCatalogSchema>;
export const designNavigationReadSchema = z.object({
  workspaceId: z.string().min(1).max(4096),
  /** Only requested after design.page-scoped-mutations.v1 negotiation. */
  pageHashes: z.literal(true).optional(),
}).strict();

/** Write acknowledgements carry every page hash, but frame descriptors only for pages whose hash the reader lacks. */
export const DESIGN_PAGE_SCOPED_MUTATIONS_CAPABILITY = "design.page-scoped-mutations.v1";
const pageHash = z.string().regex(/^[a-f0-9]{32}$/);
export const designPageHashesSchema = z
  .record(designPageIdSchema, pageHash)
  .refine((hashes) => Object.keys(hashes).length <= DESIGN_MAX_PAGES);
export type DesignPageHashes = z.infer<typeof designPageHashesSchema>;
export const designPageScopedCatalogSchema = z
  .object({
    revision,
    pages: z.array(designCatalogPageSchema.extend({ hash: pageHash }).strict()).min(1).max(DESIGN_MAX_PAGES),
    frames: z.array(designCatalogFrameSchema).max(DESIGN_CATALOG_DESCRIPTOR_LIMIT),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const fail = () => ctx.addIssue({ code: "custom", message: "Invalid page-scoped Design catalog." });
    const positions = new Map(catalog.pages.map((page, index) => [page.id, index]));
    if (
      positions.size !== catalog.pages.length ||
      new Set(catalog.pages.map((page) => portableDesignName(page.folder))).size !== catalog.pages.length ||
      (catalog.pages.length > 1 && catalog.pages.some((page) => page.folder === ""))
    )
      return fail();
    const counts = new Map<string, number>();
    const ids = new Set<string>();
    const sources = new Set<string>();
    let position = -1;
    for (const frame of catalog.frames) {
      const index = positions.get(frame.pageId);
      const page = index === undefined ? undefined : catalog.pages[index]!;
      const order = counts.get(frame.pageId) ?? 0;
      const source = portableDesignName(frame.source);
      if (
        !page || index! < position || (index! > position && counts.has(frame.pageId)) ||
        frame.order !== order || ids.has(frame.id) || sources.has(source) ||
        (page.folder ? frame.source.split("/")[0] !== page.folder : frame.source.includes("/"))
      )
        return fail();
      position = index!;
      counts.set(frame.pageId, order + 1);
      ids.add(frame.id);
      sources.add(source);
    }
    for (const [pageId, count] of counts)
      if (catalog.pages[positions.get(pageId)!]!.count !== count) return fail();
  });
export type DesignPageScopedCatalog = z.infer<typeof designPageScopedCatalogSchema>;
export const designFramesPrepareSchema = z.object({
  workspaceId: z.string().min(1).max(4096),
  directoryId: z.string().regex(/^design_[A-Za-z0-9_-]{1,64}$/),
  catalogRevision: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(designFrameFileSchema).min(1).max(16).refine((files) => new Set(files).size === files.length),
  /** Only requested after design.source-surfaces.v1 capability negotiation. */
  surfaceCosts: z.literal(true).optional(),
  /** Only requested after design.component-options.v1 capability negotiation. */
  componentOptions: z.literal(true).optional(),
  /** Only requested after design.component-identity.v1 capability negotiation. */
  includeComponentIdentity: z.literal(true).optional(),
  /** Request lint rows for this subset of files only after prepare-lint negotiation. */
  lintFiles: z.array(designFrameFileSchema).min(1).max(16).optional(),
}).strict();

/** Exposes lintFiles on design.frames.prepare. */
export const DESIGN_FRAMES_PREPARE_LINT_CAPABILITY = "design.frames.prepare-lint.v1";

/** Read lint rows for specific source versions; write acknowledgements omit rows to keep lint outside the write lock. */
export const DESIGN_FRAMES_LINT_CAPABILITY = "design.frames.lint.v1";
const versionedFrameSchema = z.object({ file: designFrameFileSchema, sourceVersion: z.string().regex(/^[a-f0-9]{24}$/) }).strict();
export const designFramesLintSchema = z.object({
  workspaceId: z.string().min(1).max(4096),
  directoryId: z.string().regex(/^design_[A-Za-z0-9_-]{1,64}$/),
  frames: z.array(versionedFrameSchema).min(1).max(16).refine((frames) => new Set(frames.map((frame) => frame.file)).size === frames.length),
}).strict();

/** DB_CHANGED designFrames names frames reached by a worktree change. */
export const DESIGN_FRAMES_CHANGES_CAPABILITY = "design.frames.changes.v1";

/** Enables component and instance metadata on design.frames.prepare via componentOptions. */
export const DESIGN_COMPONENT_OPTIONS_CAPABILITY = "design.component-options.v1";

/** Over-limit declarations report exceeds rather than losing the component record; non-declaration fields are bounded upstream. */
export const DESIGN_COMPONENT_RECORD_LIMITS = Object.freeze({
  elements: 160,
  tag: 32,
  attributes: 72,
  attributeName: 64,
  attributeValue: 2_048,
  optionName: 32,
  /** A layer's data-oid, as a bound text or host key. */
  layerId: 256,
  boundTextOptions: 8,
});
const LIMITS = DESIGN_COMPONENT_RECORD_LIMITS;

export const DESIGN_COMPONENT_RECORD_LIMIT_CODES = ["elements", "tag", "attributes", "attribute-name", "attribute-value", "layer-id"] as const;
export type DesignComponentRecordLimit = (typeof DESIGN_COMPONENT_RECORD_LIMIT_CODES)[number];

const declarationElementsSchema = z.array(z.object({
  tag: z.string().min(1).max(LIMITS.tag),
  attributes: z.array(z.object({ name: z.string().min(1).max(LIMITS.attributeName), value: z.string().max(LIMITS.attributeValue) }).strict())
    .max(LIMITS.attributes),
}).strict()).max(LIMITS.elements);
const optionReachSchema = z.record(z.string().min(1).max(LIMITS.optionName), z.enum(["css", "structure"]));
const boundedRecord = <T extends z.ZodTypeAny>(key: z.ZodString, value: T, max: number) =>
  z.record(key, value).refine((record) => Object.keys(record).length <= max, { message: `At most ${max} entries` });
const recordLimitSchema = z.enum(DESIGN_COMPONENT_RECORD_LIMIT_CODES);
/** Send nothing only to a renderer that opted in; older renderers receive defaults instead. */
const notAppliedSchema = z.enum(["last-good", "defaults", "nothing"]);

/** Advertises support for the nothing outcome when options fail. */
export const DESIGN_OPTIONS_SHOW_NOTHING_CAPABILITY = "design.component-options.shows-nothing.v1";
/** Negotiated request flag stripped before the engine dispatches the operation. */
export const DESIGN_OPTIONS_SHOW_NOTHING_PARAM = "optionsShowNothing";

/** Template holes, not the author, set these layers' text; a loop-only binding can list no options. */
export const DESIGN_COMPONENT_BOUND_TEXT_LIMIT = 512;

/** Carries authored options, their CSS or structural reach, and the fallback when values fail. */
export const designFrameComponentSchema = z.object({
  elements: declarationElementsSchema,
  reach: optionReachSchema,
  notApplied: notAppliedSchema.optional(),
  boundText: boundedRecord(z.string().min(1).max(LIMITS.layerId),
    z.array(z.string().min(1).max(LIMITS.optionName)).max(LIMITS.boundTextOptions), DESIGN_COMPONENT_BOUND_TEXT_LIMIT).optional(),
  /** The declaration is past this limit: `elements` and `reach` are empty,
   * there is no `boundText`, and the frame still renders. */
  exceeds: recordLimitSchema.optional(),
}).strict();
export type DesignFrameComponent = z.infer<typeof designFrameComponentSchema>;

const LIMIT_PATHS: ReadonlyArray<[RegExp, DesignComponentRecordLimit]> = [
  [/^elements$/, "elements"],
  [/^elements\.\d+\.tag$/, "tag"],
  [/^elements\.\d+\.attributes$/, "attributes"],
  [/^elements\.\d+\.attributes\.\d+\.name$/, "attribute-name"],
  [/^elements\.\d+\.attributes\.\d+\.value$/, "attribute-value"],
  [/^boundText(\.|$)/, "layer-id"],
];

/** Validate with the wire schema before deciding which declaration limit to report. */
export function designComponentRecordWithinLimits<T extends { elements: unknown[]; reach: Record<string, unknown>; boundText?: unknown }>(
  record: T, schema: z.ZodType = designFrameComponentSchema,
): T | (Omit<T, "boundText"> & { exceeds: DesignComponentRecordLimit }) {
  const parsed = schema.safeParse(record);
  if (parsed.success) return record;
  const issue = parsed.error.issues[0]!;
  const at = issue.path.join(".");
  // Unmapped issues are treated as declaration-shape errors.
  const exceeds = LIMIT_PATHS.find(([pattern]) => pattern.test(at))?.[1] ?? "elements";
  const { boundText: _omitted, ...rest } = record;
  return { ...rest, elements: [], reach: {}, exceeds };
}

export function designComponentRecordLimitMessage(component: string, limit: DesignComponentRecordLimit): string {
  switch (limit) {
    case "elements":
      return `The options of ${component} cannot be shown: its declaration has more than ${LIMITS.elements} elements.`;
    case "tag":
      return `The options of ${component} cannot be shown: a declaration element's tag is longer than ${LIMITS.tag} characters.`;
    case "attributes":
      return `The options of ${component} cannot be shown: a declaration element has more than ${LIMITS.attributes} attributes.`;
    case "attribute-name":
      return `The options of ${component} cannot be shown: a declaration attribute's name is longer than ${LIMITS.attributeName} characters.`;
    case "attribute-value":
      return `The options of ${component} cannot be shown: a declaration attribute's value is longer than ${LIMITS.attributeValue.toLocaleString("en-US")} characters.`;
    case "layer-id":
      return `The options of ${component} cannot be shown: a layer whose text an option sets has a data-oid longer than ${LIMITS.layerId} characters.`;
  }
}

/** Only instances owned by the frame count; over-limit frames omit their Options record. */
export const DESIGN_FRAME_INSTANCE_LIMITS = { components: 32, hosts: 256, slots: 16, slotted: 64 } as const;
const componentNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const designFrameInstanceComponentSchema = z.object({
  elements: declarationElementsSchema,
  reach: optionReachSchema,
  /** Design-root-relative file the component is in. */
  file: z.string().min(1).max(512),
  /** The file is a registered frame (its main), not a components/ file. */
  frame: z.boolean(),
  /** As on a main frame's record: its declaration is past this limit. */
  exceeds: recordLimitSchema.optional(),
}).strict();

export const designFrameInstancesSchema = z.object({
  /** Changes whenever anything below does, so a record can be compared
   * without reading it. */
  key: z.string().regex(/^[a-f0-9]{16}$/),
  components: boundedRecord(componentNameSchema, designFrameInstanceComponentSchema, DESIGN_FRAME_INSTANCE_LIMITS.components),
  hosts: boundedRecord(z.string().min(1).max(LIMITS.layerId), z.object({
    component: componentNameSchema,
    /** The host's option attributes and zd-variant, as written. */
    attributes: boundedRecord(z.string().min(1).max(LIMITS.attributeName), z.string().max(LIMITS.attributeValue), LIMITS.attributes),
    /** Some of its values did not apply. */
    failed: z.literal(true).optional(),
    /** Authored attributes the component ignores because they name no option. */
    ignored: boundedRecord(z.string().min(1).max(LIMITS.attributeName), z.string().max(LIMITS.attributeValue), LIMITS.attributes).optional(),
    /** Its part overrides: each part (lowercased, without a repeat's "#n")
     * to the declarations its zd-style-<part> attribute sets, as written. */
    overrides: boundedRecord(z.string().min(1).max(LIMITS.attributeName), z.string().max(LIMITS.attributeValue), LIMITS.attributes).optional(),
    /** The host's own style, as written, when its main's root layer is its
     * box: what the instance overrides on that root. */
    style: z.string().min(1).max(LIMITS.attributeValue).optional(),
    /** A missing source has no component entry and renders empty; a present but unusable source reports an error instead. */
    missing: z.literal(true).optional(),
    /** Decoded direct default-slot text in order, ignoring elements and comments;
     * omitted without a default slot or above the attribute limit. */
    text: z.string().max(LIMITS.attributeValue).optional(),
    /** Slot layer IDs in order; the empty key means default, and over-limit slots are omitted. */
    slotted: boundedRecord(z.string().max(LIMITS.optionName),
      z.array(z.string().min(1).max(LIMITS.layerId)).min(1).max(DESIGN_FRAME_INSTANCE_LIMITS.slotted), DESIGN_FRAME_INSTANCE_LIMITS.slots).optional(),
  }).strict(), DESIGN_FRAME_INSTANCE_LIMITS.hosts),
  /** What the frame shows when some instance's values did not apply. */
  notApplied: notAppliedSchema.optional(),
}).strict();
export type DesignFrameInstances = z.infer<typeof designFrameInstancesSchema>;

export const designComponentIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("main"), name: componentNameSchema }).strict(),
  z.object({ kind: z.literal("instance"), nodeId: z.string().min(1).max(LIMITS.layerId) }).strict(),
]);
export type DesignComponentIdentity = z.infer<typeof designComponentIdentitySchema>;

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
  component: designFrameComponentSchema.optional(),
  instances: designFrameInstancesSchema.optional(),
  componentIdentity: designComponentIdentitySchema.nullable().optional(),
}).strict();
const PREPARE_REPLY_ERRORS = 16;
/** When per-frame lint rows hit the cap, keep the most severe. */
export const DESIGN_PREPARED_LINT_ROWS_PER_FRAME = 256;
const preparedLintSchema = z.object({
  /** Every file linted; a file listed with no rows has none. */
  checkedFiles: z.array(designFrameFileSchema).max(16),
  violations: z.array(z.object({
    ruleId: z.string().min(1).max(64),
    severity: z.enum(["error", "warning"]),
    message: z.string().max(16_384),
    file: designFrameFileSchema,
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    oid: z.string().max(256).optional(),
    fix: z.string().max(16_384).optional(),
  }).strict()).max(16 * DESIGN_PREPARED_LINT_ROWS_PER_FRAME),
}).strict();
export const designFramesPrepareReplySchema = z.object({
  directoryId,
  catalogRevision: revision,
  frames: z.array(designPreparedFrameSchema).max(16),
  errors: z.array(z.object({ file: designFrameFileSchema, message: z.string().max(16_384) }).strict()).max(PREPARE_REPLY_ERRORS),
  /** Present only when the request named lintFiles. */
  lint: preparedLintSchema.optional(),
}).strict();
/** `frames` names those linted at the version asked for; a frame whose
 * source moved on is left out and has no rows. */
export const designFramesLintReplySchema = preparedLintSchema.extend({
  frames: z.array(versionedFrameSchema).max(16),
}).strict();
const prepareReplyEnvelopeSchema = designFramesPrepareReplySchema.extend({ frames: z.array(z.unknown()).max(16), lint: z.unknown().optional() });

export const DESIGN_PREPARED_FRAME_INVALID_MESSAGE = "Zeros could not read this frame's prepared record.";

/** A malformed frame becomes an error if it names a valid file; otherwise reject the reply. */
export function parseDesignFramesPrepareReply(raw: unknown, negotiated: { optionsShowNothing?: boolean } = {}): z.infer<typeof designFramesPrepareReplySchema> {
  // Recheck the error cap because malformed frame records add errors after envelope validation.
  const envelope = prepareReplyEnvelopeSchema.parse(raw);
  const frames: z.infer<typeof designPreparedFrameSchema>[] = [];
  const errors = [...envelope.errors];
  for (const candidate of envelope.frames) {
    const parsed = designPreparedFrameSchema.safeParse(candidate);
    if (parsed.success && (negotiated.optionsShowNothing ||
      (parsed.data.component?.notApplied !== "nothing" && parsed.data.instances?.notApplied !== "nothing"))) {
      frames.push(parsed.data);
      continue;
    }
    errors.push({ file: designFrameFileSchema.parse((candidate as { file?: unknown } | null)?.file), message: DESIGN_PREPARED_FRAME_INVALID_MESSAGE });
  }
  if (errors.length > PREPARE_REPLY_ERRORS) throw new Error(`A preparation reply reports at most ${PREPARE_REPLY_ERRORS} frame errors.`);
  // A malformed advisory lint record never invalidates prepared frames.
  const { lint: rawLint, ...rest } = envelope;
  const lint = rawLint === undefined ? undefined : preparedLintSchema.safeParse(rawLint);
  return { ...rest, frames, errors, ...(lint?.success ? { lint: lint.data } : {}) };
}
