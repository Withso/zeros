import { createHash } from "node:crypto";
import { z } from "zod";

export const DESIGN_CANVAS_FILE = "canvas.json";
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/);
const title = z.string().max(120);
const source = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/i);
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
    z: z.number().int().min(0).max(256).optional(),
    geometryMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const pageSchema = z
  .object({
    id,
    title,
    frames: z.array(id).max(256),
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
      .refine((frames) => Object.keys(frames).length <= 256),
  })
  .passthrough();

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Design canvas metadata must contain objects.");
  return value as RecordValue;
};

/** The public file is a small scene index. The existing HTML engine continues
 * to address documents by source path; its IPC/document IDs remain compatible. */
export function decodeCanvasFile(source: string): RecordValue {
  const value = JSON.parse(source);
  if (value?.version !== 1)
    throw new Error(`Unsupported design canvas version: ${value?.version}`);
  const result = canvasSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      `Invalid Design canvas frame geometry or metadata: ${result.error.message}`,
    );
  const parsed = result.data;
  const {
    frames,
    pages = [{ id: "main", title: "Design", frames: Object.keys(frames) }],
    ...rest
  } = parsed;
  const order = pages[0].frames;
  if (
    new Set(order).size !== order.length ||
    order.length !== Object.keys(frames).length ||
    order.some((frameId) => !Object.hasOwn(frames, frameId))
  )
    throw new Error(
      "Every Design frame must appear exactly once on the canvas page.",
    );
  const files = new Set<string>();
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
    const portable = file.normalize("NFC").toLowerCase();
    if (files.has(portable))
      throw new Error("Design frames must have distinct source files.");
    files.add(portable);
    geometry[file] = {
      ...geometryMetadata,
      x,
      y,
      w: width,
      h: height,
      z: z ?? order.indexOf(frameId),
    };
    info[file] = {
      ...extensions,
      id: frameId,
      title,
      kind: kind === "text" ? "text" : "frame",
    };
  }
  return { ...rest, version: 3, pages, frames: geometry, frame_info: info };
}

export function legacyFrameId(file: string): string {
  return `frame_${createHash("sha256").update(file).digest("hex").slice(0, 24)}`;
}

/** Preserve unknown fields and source identities when canvas controls write
 * geometry. No live DOM, local camera, credentials or caches enter this file. */
export function encodeCanvasFile(document: RecordValue): string {
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
      z: Math.round(bounded(old.z, 0, 0, 256)),
    };
  };
  const entries = Object.entries(record(frames === undefined ? {} : frames))
    .map(([file, geometry]) => [file, geometryFor(geometry)] as const)
    .sort(([, left], [, right]) => Number(left.z ?? 0) - Number(right.z ?? 0));
  if (
    Object.keys(information).some(
      (file) => !entries.some(([source]) => source === file),
    )
  )
    throw new Error("Invalid Design frame information reference.");
  const authored: Record<string, z.infer<typeof frameSchema>> = {};
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
    authored[frameId] = frameSchema.parse({
      ...extensions,
      kind: kind === "text" ? "text" : "html",
      source: file,
      title: suppliedTitle ?? file.replace(/\.html$/i, ""),
      x: geometry.x,
      y: geometry.y,
      width: geometry.w,
      height: geometry.h,
      ...(geometry.z !== Object.keys(authored).length ? { z: geometry.z } : {}),
      ...(Object.keys(geometryMetadata).length ? { geometryMetadata } : {}),
    });
  }
  const page =
    pages === undefined
      ? { id: "main", title: "Design" }
      : z.array(pageSchema).length(1).parse(pages)[0];
  const result = canvasSchema.parse({
    ...rest,
    version: 1,
    pages: [{ ...page, frames: Object.keys(authored) }],
    frames: authored,
  });
  // Validate cross references and portable source aliases before persistence.
  const sourceText = JSON.stringify(result, null, 2) + "\n";
  decodeCanvasFile(sourceText);
  return sourceText;
}
