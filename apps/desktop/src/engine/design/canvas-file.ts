import { createHash } from "node:crypto";
import { z } from "zod";
import {
  designFrameFileSchema,
  designPageFolderProblem,
  portableDesignName,
} from "@zeros/protocol/design-path";
import {
  DESIGN_MAX_FRAMES_PER_PAGE,
  DESIGN_MAX_PAGES,
} from "@zeros/protocol/design-pages";
import { assertDesignPagesWithinFrameLimit } from "./frame-limits";

export const DESIGN_CANVAS_FILE = "canvas.json";
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/);
const title = z.string().max(120);
const source = designFrameFileSchema;
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const size = z.number().finite().min(1).max(16_384);
const frameSchema = z
  .object({
    kind: z.enum(["html", "text"]),
    source,
    title,
    x: coordinate,
    y: coordinate,
    width: size,
    height: size,
    z: z.number().int().min(0).max(DESIGN_MAX_FRAMES_PER_PAGE).optional(),
    geometryMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const pageSchema = z
  .object({
    id,
    title,
    frames: z.array(id).max(DESIGN_MAX_FRAMES_PER_PAGE),
  })
  .passthrough();
const canvasSchema = z
  .object({
    version: z.literal(1),
    id: id.default("main"),
    title: title.default("Design"),
    pages: z.array(pageSchema).length(1).optional(),
    frames: z
      .record(id, frameSchema)
      .refine((frames) => Object.keys(frames).length <= DESIGN_MAX_FRAMES_PER_PAGE),
  })
  .passthrough();
const PAGE_FOLDER_ISSUE = "zeros-design-page-folder";
const pageFolderSchema = z.string().superRefine((folder, context) => {
  const problem = designPageFolderProblem(folder);
  if (problem)
    context.addIssue({
      code: "custom",
      message: problem,
      params: { kind: PAGE_FOLDER_ISSUE },
    });
});
const pagedCanvasSchema = canvasSchema.extend({
  version: z.literal(2),
  pages: z.array(pageSchema.extend({ folder: pageFolderSchema })).min(1).max(DESIGN_MAX_PAGES),
  // Every frame sits on exactly one page, so the page caps bound the total.
  frames: z
    .record(id, frameSchema)
    .refine((frames) => Object.keys(frames).length <= DESIGN_MAX_PAGES * DESIGN_MAX_FRAMES_PER_PAGE),
});

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Design canvas metadata must contain objects.");
  return value as RecordValue;
};
const plainObject = (value: unknown): value is RecordValue =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Canvas v1 is one page: its frames record is the page's membership. */
const singlePageTitle = (pages: unknown): unknown =>
  Array.isArray(pages) && plainObject(pages[0]) ? pages[0].title : "Design";

type ParsedPage = z.infer<typeof pageSchema> & { folder?: string };

/** Cross-references the schema cannot express: every frame on exactly one
 * page, inside its page folder, with a portable source no other frame uses. */
function assertCanvasMembership(
  version: 1 | 2,
  pages: readonly ParsedPage[],
  frames: Record<string, z.infer<typeof frameSchema>>,
): Map<string, { page: ParsedPage; index: number }> {
  const order = pages.flatMap((page) => page.frames);
  const placement = new Map(
    pages.flatMap((page) =>
      page.frames.map((frameId, index) => [frameId, { page, index }] as const),
    ),
  );
  if (
    version === 2 &&
    (new Set(pages.map((page) => page.id)).size !== pages.length ||
      new Set(pages.map((page) => portableDesignName(String(page.folder))))
        .size !== pages.length)
  )
    throw new Error("Design pages must have distinct IDs and folders.");
  if (
    placement.size !== order.length ||
    order.length !== Object.keys(frames).length ||
    order.some((frameId) => !Object.hasOwn(frames, frameId))
  )
    throw new Error(
      "Every Design frame must appear exactly once on a canvas page.",
    );
  const files = new Set<string>();
  for (const [frameId, { source: file }] of Object.entries(frames)) {
    const { page } = placement.get(frameId)!;
    if (version === 1 ? file.includes("/") : file.split("/")[0] !== page.folder || file.split("/").length !== 2)
      throw new Error("Design frame source must be inside its page folder.");
    const portable = portableDesignName(file);
    if (files.has(portable))
      throw new Error("Design frames must have distinct source files.");
    files.add(portable);
  }
  return placement;
}

type ParsedCanvas = z.infer<typeof canvasSchema> | z.infer<typeof pagedCanvasSchema>;
interface ValidatedCanvas {
  version: 1 | 2;
  frames: number;
  /** Absent for encoder output until a read needs it: its bytes are valid by construction. */
  parsed?: ParsedCanvas;
  canonical: boolean;
}

/** Canvases already validated, by content hash, most recently used last. A
 * large canvas is validated once per distinct content instead of on every
 * read and write; callers still receive fresh objects they may mutate. */
const MAX_VALIDATED_CANVASES = 4;
const validatedCanvases = new Map<string, ValidatedCanvas>();
let validations = 0;
const canvasKey = (source: string) =>
  createHash("sha256").update(source).digest("hex");

function rememberValidatedCanvas(key: string, entry: ValidatedCanvas): void {
  validatedCanvases.delete(key);
  validatedCanvases.set(key, entry);
  let frames = 0;
  for (const value of validatedCanvases.values()) frames += value.frames;
  while (
    validatedCanvases.size > MAX_VALIDATED_CANVASES ||
    (validatedCanvases.size > 1 && frames > DESIGN_MAX_PAGES * DESIGN_MAX_FRAMES_PER_PAGE)
  ) {
    const [oldest, value] = validatedCanvases.entries().next().value!;
    validatedCanvases.delete(oldest);
    frames -= value.frames;
  }
}

export function designCanvasValidationsForTests(): number {
  return validations;
}

let materializations = 0;

/** Test hook: decodes that built fresh canvas objects. */
export function designCanvasMaterializationsForTests(): number {
  return materializations;
}

/** Exactly the bytes this encoder produced, so formatting carries no meaning. */
export function isCanonicalDesignCanvas(source: string): boolean {
  return validatedCanvases.get(canvasKey(source))?.canonical === true;
}

const cloneEntries = <T extends RecordValue | undefined>(value: T): T => {
  if (!value) return value;
  for (const _key in value) return structuredClone(value);
  return value;
};

/** Fresh output objects every time: callers edit pages, frames and extensions. */
function materializeCanvas(parsed: ParsedCanvas): RecordValue {
  materializations++;
  const {
    frames,
    pages: parsedPages = [{ id: "main", title: "Design", frames: Object.keys(frames) }],
    ...rest
  } = parsed;
  const pages = structuredClone(parsedPages);
  const order = new Map(
    pages.flatMap((page) => page.frames.map((frameId, index) => [frameId, index] as const)),
  );
  const geometry: RecordValue = {};
  const info: RecordValue = {};
  for (const [frameId, frame] of Object.entries(frames)) {
    const {
      source: file,
      kind,
      title,
      x,
      y,
      width,
      height,
      z,
      geometryMetadata,
      ...extensions
    } = frame;
    geometry[file] = {
      ...cloneEntries(geometryMetadata),
      x,
      y,
      w: width,
      h: height,
      z: z ?? order.get(frameId)!,
    };
    info[file] = {
      ...cloneEntries(extensions),
      id: frameId,
      title,
      kind: kind === "text" ? "text" : "frame",
    };
  }
  return { ...structuredClone(rest), version: 3, pages, frames: geometry, frame_info: info };
}

/** The public file is a small scene index. The existing HTML engine continues
 * to address documents by source path; its IPC/document IDs remain compatible. */
export function decodeCanvasFile(source: string, options?: { version: 1 | 2 }): RecordValue {
  const key = canvasKey(source);
  const known = validatedCanvases.get(key);
  if (known) {
    if (options && options.version !== known.version)
      throw new Error(`Design layout requires canvas version ${options.version}; found ${known.version}.`);
    known.parsed ??= JSON.parse(source) as ParsedCanvas;
    rememberValidatedCanvas(key, known);
    return materializeCanvas(known.parsed);
  }
  const value = JSON.parse(source);
  if (value?.version !== 1 && value?.version !== 2)
    throw new Error(`Unsupported design canvas version: ${value?.version}`);
  if (options && options.version !== value.version)
    throw new Error(`Design layout requires canvas version ${options.version}; found ${value.version}.`);
  assertDesignPagesWithinFrameLimit(
    value.version === 2
      ? Array.isArray(value.pages) ? value.pages.filter(plainObject) : []
      : [{ title: singlePageTitle(value.pages), frames: plainObject(value.frames) ? Object.keys(value.frames) : [] }],
  );
  const result = (value.version === 2 ? pagedCanvasSchema : canvasSchema).safeParse(value);
  if (!result.success) {
    // A page folder an agent chose natively gets its own explanation and a
    // valid replacement; other schema failures keep the established detail.
    const folders = result.error.issues.filter(
      (issue) =>
        issue.code === "custom" &&
        (issue as { params?: { kind?: unknown } }).params?.kind ===
          PAGE_FOLDER_ISSUE,
    );
    if (folders.length > 0)
      throw new Error(
        `Invalid Design canvas page folder: ${folders
          .map((issue) => issue.message)
          .join(" ")}`,
      );
    throw new Error(
      `Invalid Design canvas frame geometry or metadata: ${result.error.message}`,
    );
  }
  const parsed = result.data;
  assertCanvasMembership(
    parsed.version,
    parsed.pages ?? [{ id: "main", title: "Design", frames: Object.keys(parsed.frames) }],
    parsed.frames,
  );
  validations++;
  rememberValidatedCanvas(key, {
    version: parsed.version,
    frames: Object.keys(parsed.frames).length,
    parsed,
    canonical: false,
  });
  return materializeCanvas(parsed);
}

export function legacyFrameId(file: string): string {
  return `frame_${createHash("sha256").update(file).digest("hex").slice(0, 24)}`;
}

/** Preserve unknown fields and source identities when canvas controls write
 * geometry. No live DOM, local camera, credentials or caches enter this file. */
export function encodeCanvasFile(document: RecordValue, options: { version: 1 | 2 } = { version: 1 }): string {
  if (
    document.version !== undefined &&
    ![1, 2, 3].includes(document.version as number)
  )
    throw new Error(`Unsupported design canvas version: ${document.version}`);
  const {
    version: _version,
    frames,
    frame_info,
    view: _view,
    pages,
    ...rest
  } = document;
  assertDesignPagesWithinFrameLimit(
    options.version === 2
      ? Array.isArray(pages) ? pages.filter(plainObject) : []
      : [{ title: singlePageTitle(pages), frames: Object.keys(record(frames === undefined ? {} : frames)) }],
  );
  const pagedPages = options.version === 2 ? pagedCanvasSchema.shape.pages.parse(pages) : undefined;
  const pageOrder = pagedPages && new Map(pagedPages.flatMap((page) =>
    page.frames.map((frameId, index) => [frameId, index] as const),
  ));
  const information = frame_info === undefined ? {} : record(frame_info);
  const geometryFor = (value: unknown): RecordValue => {
    if (document.version === 3) return record(value);
    // Legacy canvas v1/v2 defaulted and clamped missing/out-of-range geometry.
    // Preserve that migration contract; the current format remains strict.
    const old =
      value && typeof value === "object" && !Array.isArray(value)
        ? record(value)
        : {};
    const bounded = (
      value: unknown,
      fallback: number,
      min: number,
      max: number,
    ) =>
      typeof value === "number" && Number.isFinite(value)
        ? Math.min(max, Math.max(min, value))
        : fallback;
    return {
      ...old,
      x: bounded(old.x, 0, -1_000_000, 1_000_000),
      y: bounded(old.y, 0, -1_000_000, 1_000_000),
      w: bounded(old.w, 1440, 1, 16384),
      h: bounded(old.h, 900, 1, 16384),
      z: Math.round(bounded(old.z, 0, 0, DESIGN_MAX_FRAMES_PER_PAGE)),
    };
  };
  // Undefined values are absent, as in the JSON this encodes: callers may
  // pass their working objects rather than a JSON copy.
  const entries = Object.entries(record(frames === undefined ? {} : frames))
    .filter(([, geometry]) => geometry !== undefined)
    .map(([file, geometry]) => [file, geometryFor(geometry)] as const)
    .sort(([, left], [, right]) => Number(left.z ?? 0) - Number(right.z ?? 0));
  const sources = new Set(entries.map(([file]) => file));
  if (Object.entries(information).some(([file, value]) => value !== undefined && !sources.has(file)))
    throw new Error("Invalid Design frame information reference.");
  const authored: Record<string, z.infer<typeof frameSchema>> = {};
  let position = 0;
  for (const [file, value] of entries) {
    const geometry = record(value);
    const { x: _x, y: _y, w: _w, h: _h, z: _z, ...geometryMetadata } = geometry;
    const {
      id: suppliedId,
      title: suppliedTitle,
      kind,
      ...extensions
    } = record(information[file] ?? {});
    if (kind !== undefined && kind !== "frame" && kind !== "text")
      throw new Error("Unsupported legacy Design frame kind.");
    const frameId =
      suppliedId === undefined ? legacyFrameId(file) : id.parse(suppliedId);
    if (Object.hasOwn(authored, frameId))
      throw new Error("Duplicate Design frame identity.");
    // The whole-document parse below validates and orders every frame.
    authored[frameId] = {
      ...extensions,
      kind: kind === "text" ? "text" : "html",
      source: file,
      title: suppliedTitle ?? file.replace(/\.html$/i, ""),
      x: geometry.x,
      y: geometry.y,
      width: geometry.w,
      height: geometry.h,
      ...(geometry.z !== (pageOrder?.get(frameId) ?? position) ? { z: geometry.z } : {}),
      ...(Object.values(geometryMetadata).some((value) => value !== undefined) ? { geometryMetadata } : {}),
    } as z.infer<typeof frameSchema>;
    position++;
  }
  const outputPages = options.version === 2
    ? pagedPages
    : [{ ...(pages === undefined ? { id: "main", title: "Design" } : z.array(pageSchema).length(1).parse(pages)[0]), frames: Object.keys(authored) }];
  const result = (options.version === 2 ? pagedCanvasSchema : canvasSchema).parse({
    ...rest,
    version: options.version,
    pages: outputPages,
    frames: authored,
  });
  // Validate cross references and portable source aliases before persistence.
  assertCanvasMembership(options.version, result.pages ?? [], result.frames);
  const text = JSON.stringify(result, null, 2) + "\n";
  rememberValidatedCanvas(canvasKey(text), {
    version: options.version,
    frames: Object.keys(result.frames).length,
    canonical: true,
  });
  return text;
}
